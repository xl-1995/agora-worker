/**
 * agora-worker - the BYO Agent that claims tasks from the AGORA platform,
 * hands them off to your local LLM (Codex / Claude Code / anything that can
 * read+write JSON files), and submits the result.
 *
 * Architecture:
 *   1. SIWE login with your PRIVATE_KEY -> JWT (cached in memory).
 *   2. Poll GET /tasks/open every WORKER_POLL_MS, filter by caps + chain.
 *   3. For each match: POST /tasks/:id/claim (stakes the bond on-chain in Phase 1c).
 *   4. Either:
 *        a) WORKER_AUTO=1 -> run the built-in default handler, OR
 *        b) write inbox/<id>.json, wait for outbox/<id>.json from your local agent.
 *   5. POST /tasks/:id/submit (auto-settles in V1 -> you get paid).
 *
 * Claimed tasks are processed concurrently (up to maxInflight) so a single
 * long-running handoff never blocks the poll loop from claiming more work.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { fetchJson, httpFetch, HttpError } from "./http.js";
import { validateDeliverable } from "./validate.js";

export interface WorkerConfig {
  apiUrl: string;
  privateKey?: `0x${string}`;
  apiKey?: string;
  caps: string[];
  chain: string;
  inbox: string;
  outbox: string;
  pollMs: number;
  auto: boolean;
  maxInflight: number;
}

export interface TaskRow {
  id: string;
  publisher_id: string;
  kind: string;
  category: string | null;
  title: string | null;
  description: string | null;
  chain: string | null;
  target_address: string | null;
  params: string;
  reward_agio: number;
  agent_bond_agio: number;
  status: string;
  claimed_agent_id: string | null;
  claim_deadline: number | null;
  submit_deadline: number | null;
  created_at: number;
}

const PROFILE_REFRESH_MS = 5 * 60_000;
const DEFAULT_DEADLINE_MS = 10 * 60_000;
const OUTBOX_POLL_MS = 2_000;

const log = (s: string) => console.log(`[agora-worker] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------- auth flow
async function login(cfg: WorkerConfig, account: PrivateKeyAccount): Promise<string> {
  // 1. Ask the API for a nonce keyed to our address.
  const { nonce, statement, domain } = await fetchJson<{ nonce: string; statement: string; domain: string }>(
    `${cfg.apiUrl}/auth/nonce`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: account.address }),
    },
  );

  // 2. Build the SIWE message (EIP-4361).
  const issuedAt = new Date().toISOString();
  const message =
    `${domain} wants you to sign in with your Ethereum account:\n` +
    `${account.address}\n` +
    `\n` +
    `${statement}\n` +
    `\n` +
    `URI: ${cfg.apiUrl}\n` +
    `Version: 1\n` +
    `Chain ID: 56\n` +
    `Nonce: ${nonce}\n` +
    `Issued At: ${issuedAt}`;

  const signature = await account.signMessage({ message });

  // 3. Exchange for a JWT.
  const { token } = await fetchJson<{ token: string }>(`${cfg.apiUrl}/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, signature }),
  });
  return token;
}

async function authenticate(cfg: WorkerConfig): Promise<{ token: string; account?: PrivateKeyAccount }> {
  if (cfg.apiKey) return { token: cfg.apiKey };
  if (!cfg.privateKey) throw new Error("missing PRIVATE_KEY or AGORA_API_KEY");
  const account = privateKeyToAccount(cfg.privateKey);
  return { token: await login(cfg, account), account };
}

// ------------------------------------------------------------ API helpers
const authed = (token: string) => ({ "content-type": "application/json", authorization: `Bearer ${token}` });

/**
 * Discover claimable open tasks. Early phase: ANY agent can claim ANY task, so
 * we pull the whole open pool and sort the agent's specialties to the front —
 * when several workers race for the same task, the best-matched one tends to
 * claim first. A task is "matched" when its category is one of the agent's
 * registered specialties OR its kind is one of the configured `caps`. In
 * `--auto` (GoPlus-only) mode we keep just the on-chain tasks, since the
 * built-in handler can't do general work.
 */
async function pollOpen(cfg: WorkerConfig, token: string, categories: string[]): Promise<TaskRow[]> {
  const url = new URL(`${cfg.apiUrl}/tasks/open`);
  url.searchParams.set("all", "1");
  url.searchParams.set("limit", "50");
  let tasks = (await fetchJson<{ tasks: TaskRow[] }>(url, { headers: authed(token) })).tasks;

  // Auto mode only knows GoPlus contract scans.
  if (cfg.auto) tasks = tasks.filter((t) => !!t.target_address);

  // Specialty-first ordering (priority), then oldest-first within each group.
  const cat = new Set(categories);
  const caps = new Set(cfg.caps);
  const matched = (t: TaskRow) => (t.category && cat.has(t.category)) || caps.has(t.kind);
  tasks.sort((a, b) => {
    const d = Number(matched(b)) - Number(matched(a));
    return d !== 0 ? d : a.created_at - b.created_at;
  });
  return tasks;
}

/** Fetch the agent's registered specialty categories (empty if no profile). */
async function fetchAgentCategories(cfg: WorkerConfig, token: string): Promise<string[]> {
  try {
    const { profile } = await fetchJson<{ profile: { categories?: string[] } | null }>(
      `${cfg.apiUrl}/agent/profile`,
      { headers: authed(token) },
    );
    return Array.isArray(profile?.categories) ? profile!.categories! : [];
  } catch {
    return [];
  }
}

async function claim(cfg: WorkerConfig, token: string, id: string): Promise<TaskRow | null> {
  const res = await httpFetch(`${cfg.apiUrl}/tasks/${id}/claim`, { method: "POST", headers: authed(token) });
  if (res.status === 409) return null; // someone else won the race
  if (!res.ok) throw new HttpError(res.status, `${cfg.apiUrl}/tasks/${id}/claim`, await res.text().catch(() => ""));
  return ((await res.json()) as { task: TaskRow }).task;
}

async function submit(cfg: WorkerConfig, token: string, id: string, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  const result_hash = "0x" + createHash("sha256").update(body).digest("hex");
  const p = (payload ?? {}) as Record<string, unknown>;
  // A `verdict` field marks an on-chain intel report; otherwise it's a general
  // task deliverable: a one-line summary + a full Markdown `body` + optional
  // file `attachments` (R2 URLs) + optional external `result_url`.
  const isReport = typeof p.verdict === "string";
  const result_url = (typeof p.result_url === "string" && p.result_url) || `inline://${result_hash.slice(0, 16)}`;
  const reqBody = isReport
    ? { result_hash, result_url, report: payload }
    : {
        result_hash,
        result_url,
        summary: typeof p.summary === "string" ? p.summary : "completed",
        body: typeof p.body === "string" ? p.body : undefined,
        attachments: Array.isArray(p.attachments) ? p.attachments.filter((x) => typeof x === "string") : undefined,
      };
  await fetchJson(`${cfg.apiUrl}/tasks/${id}/submit`, {
    method: "POST",
    headers: authed(token),
    body: JSON.stringify(reqBody),
  });
}

// --------------------------------------------------- file handoff with local LLM
async function handoffToLocalAgent(
  cfg: WorkerConfig,
  task: TaskRow,
  deadlineMs: number,
  stopping: () => boolean,
): Promise<unknown> {
  await fs.mkdir(cfg.inbox, { recursive: true });
  await fs.mkdir(cfg.outbox, { recursive: true });
  const inboxPath = path.join(cfg.inbox, `${task.id}.json`);
  const outboxPath = path.join(cfg.outbox, `${task.id}.json`);

  // On-chain intel tasks carry a contract; general tasks carry a title/brief.
  const isOnChain = !!task.target_address;

  // Drop the task spec for the local agent to pick up.
  const spec = {
    task_id: task.id,
    kind: task.kind,
    category: task.category,
    title: task.title,
    description: task.description,
    chain: task.chain,
    target_address: task.target_address,
    params: JSON.parse(task.params || "{}"),
    reward_agio: task.reward_agio,
    deadline_ms: deadlineMs,
    instructions: isOnChain
      ? "On-chain intelligence task. Analyze the contract at target_address on `chain`. Write the result JSON to outbox/<task_id>.json with fields: { verdict: 'low'|'medium'|'high'|'critical', safety: [...], fund_flow: [...], smart_money: [...], deployer: {...}, assessment: [...], sources: [...] }"
      : "General task. Do the work described in `title`/`description`. Write the result JSON to outbox/<task_id>.json with fields: { summary: '<one-line result>', result_url?: '<link to deliverable, if any>' }. Do not invent facts; cite sources in the summary when relevant.",
  };
  await fs.writeFile(inboxPath, JSON.stringify(spec, null, 2));
  log(`inbox/${task.id}.json ready - run your local agent (Codex/Claude Code/etc.) on it.`);

  try {
    // Poll for the outbox file. Read only once the file size is stable across two
    // checks, so we never parse a half-written file the local agent is still writing.
    // Each new stable version is self-checked before we accept it; a version that
    // fails is reported once and left in place so the agent can correct and re-save.
    let lastSize = -1;
    let rejectedSize = -1;
    while (Date.now() < deadlineMs && !stopping()) {
      const stable = await stableFile(outboxPath, lastSize);
      lastSize = stable.size;
      if (stable.ready && stable.size !== rejectedSize) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(await fs.readFile(outboxPath, "utf-8"));
        } catch {
          log(`outbox/${task.id}.json: invalid JSON — waiting for a fix.`);
          rejectedSize = stable.size;
          await sleep(OUTBOX_POLL_MS);
          continue;
        }
        const { errors } = validateDeliverable(parsed, task);
        if (errors.length > 0) {
          log(`outbox/${task.id}.json failed self-check (not submitted) — fix and re-save:`);
          for (const e of errors) log(`  - ${e}`);
          rejectedSize = stable.size;
          await sleep(OUTBOX_POLL_MS);
          continue;
        }
        log(`outbox/${task.id}.json picked up.`);
        await fs.unlink(outboxPath).catch(() => {});
        return parsed;
      }
      await sleep(OUTBOX_POLL_MS);
    }
    throw new Error(stopping() ? "shutting_down" : "submit_deadline_exceeded");
  } finally {
    await fs.unlink(inboxPath).catch(() => {});
  }
}

/** A file is "ready" once it exists, is non-empty, and its size held steady since the last poll. */
async function stableFile(p: string, prevSize: number): Promise<{ ready: boolean; size: number }> {
  try {
    const { size } = await fs.stat(p);
    return { ready: size > 0 && size === prevSize, size };
  } catch {
    return { ready: false, size: -1 };
  }
}

// -------------------------------------------------------------------- loop
export async function startWorker(cfg: WorkerConfig, defaultHandler: (task: TaskRow) => Promise<unknown>): Promise<void> {
  const { token: initialToken, account } = await authenticate(cfg);
  let token = initialToken;
  if (account) log(`agent address: ${account.address}`);
  if (cfg.apiKey) log("auth: AGORA_API_KEY");
  log(`api: ${cfg.apiUrl} | caps: [${cfg.caps.join(", ")}] | chain: ${cfg.chain || "any"} | auto: ${cfg.auto} | maxInflight: ${cfg.maxInflight}`);

  log(cfg.apiKey ? "logged in (API key)" : "logged in (SIWE)");

  // Any agent can claim any task; specialties just set claim priority.
  let categories = await fetchAgentCategories(cfg, token);
  if (categories.length > 0) {
    log(`claiming any open task; specialty priority: [${categories.join(", ")}]`);
  } else {
    log("claiming any open task. Register an identity at /app/agent to prioritize your specialties.");
  }
  let lastProfileCheck = Date.now();

  // Make sure inbox/outbox dirs exist up-front in file-handoff mode.
  if (!cfg.auto) {
    await fs.mkdir(cfg.inbox, { recursive: true });
    await fs.mkdir(cfg.outbox, { recursive: true });
  }

  // Graceful shutdown: stop claiming on SIGINT/SIGTERM, let in-flight tasks drain.
  let stopping = false;
  const onStop = () => {
    if (stopping) return;
    stopping = true;
    log("shutting down - draining in-flight tasks (Ctrl-C again to force quit)...");
    process.once("SIGINT", () => process.exit(130));
    process.once("SIGTERM", () => process.exit(143));
  };
  process.once("SIGINT", onStop);
  process.once("SIGTERM", onStop);

  // Tasks currently being processed; bounds concurrency and prevents re-claiming.
  const inFlight = new Set<string>();

  const reauth = async () => {
    if (account) {
      log("re-authenticating...");
      try {
        token = await login(cfg, account);
      } catch (ee) {
        log(`re-auth failed: ${ee}`);
      }
    } else {
      log("API key rejected; create a fresh key in the AGORA web app.");
    }
  };

  const processTask = async (task: TaskRow): Promise<void> => {
    try {
      const won = await claim(cfg, token, task.id);
      if (!won) return; // lost the race
      log(`claimed ${task.id} (${task.kind} on ${task.chain} -> ${task.target_address})`);
      const deadline = won.submit_deadline ?? Date.now() + DEFAULT_DEADLINE_MS;
      const report = cfg.auto ? await defaultHandler(won) : await handoffToLocalAgent(cfg, won, deadline, () => stopping);
      // Final pre-submit gate: never submit a deliverable that fails its own shape.
      const { errors, warnings } = validateDeliverable(report, won);
      for (const w of warnings) log(`${task.id} warning: ${w}`);
      if (errors.length > 0) throw new Error(`self-check failed, not submitting: ${errors.join("; ")}`);
      await submit(cfg, token, task.id, report);
      log(`submitted ${task.id} - settled, payout received.`);
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) await reauth();
      log(`${task.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      inFlight.delete(task.id);
    }
  };

  while (!stopping) {
    try {
      // Refresh the profile on a wall-clock interval so a newly-registered
      // identity (or updated specialties) starts matching without a restart.
      if (Date.now() - lastProfileCheck >= PROFILE_REFRESH_MS) {
        lastProfileCheck = Date.now();
        const fresh = await fetchAgentCategories(cfg, token);
        if (fresh.length > 0 && fresh.join(",") !== categories.join(",")) {
          categories = fresh;
          log(`specialties updated: [${categories.join(", ")}]`);
        }
      }

      const open = await pollOpen(cfg, token, categories);
      for (const task of open) {
        if (inFlight.size >= cfg.maxInflight) break; // at capacity; pick up the rest next poll
        if (inFlight.has(task.id)) continue;
        inFlight.add(task.id);
        void processTask(task); // fire-and-forget; the poll loop keeps claiming
      }
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) await reauth();
      else log(`poll error: ${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(cfg.pollMs);
  }

  // Drained on shutdown: wait for in-flight tasks (bounded by their own deadlines).
  while (inFlight.size > 0) {
    log(`waiting for ${inFlight.size} in-flight task(s) to finish...`);
    await sleep(OUTBOX_POLL_MS);
  }
  log("clean shutdown.");
}
