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
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

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

const log = (s: string) => console.log(`[agora-worker] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------- auth flow
async function login(cfg: WorkerConfig, account: PrivateKeyAccount): Promise<string> {
  // 1. Ask the API for a nonce keyed to our address.
  const nonceRes = await fetch(`${cfg.apiUrl}/auth/nonce`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: account.address }),
  });
  if (!nonceRes.ok) throw new Error(`/auth/nonce ${nonceRes.status}: ${await nonceRes.text()}`);
  const { nonce, statement, domain } = (await nonceRes.json()) as { nonce: string; statement: string; domain: string };

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
  const verifyRes = await fetch(`${cfg.apiUrl}/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, signature }),
  });
  if (!verifyRes.ok) throw new Error(`/auth/verify ${verifyRes.status}: ${await verifyRes.text()}`);
  const { token } = (await verifyRes.json()) as { token: string };
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

async function pollOpen(cfg: WorkerConfig, token: string): Promise<TaskRow[]> {
  const url = new URL(`${cfg.apiUrl}/tasks/open`);
  url.searchParams.set("caps", cfg.caps.join(","));
  if (cfg.chain) url.searchParams.set("chain", cfg.chain);
  const res = await fetch(url, { headers: authed(token) });
  if (!res.ok) throw new Error(`/tasks/open ${res.status}`);
  return ((await res.json()) as { tasks: TaskRow[] }).tasks;
}

async function claim(cfg: WorkerConfig, token: string, id: string): Promise<TaskRow | null> {
  const res = await fetch(`${cfg.apiUrl}/tasks/${id}/claim`, { method: "POST", headers: authed(token) });
  if (res.status === 409) return null; // someone else won the race
  if (!res.ok) throw new Error(`/tasks/${id}/claim ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { task: TaskRow }).task;
}

async function submit(cfg: WorkerConfig, token: string, id: string, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  const result_hash = "0x" + createHash("sha256").update(body).digest("hex");
  const p = (payload ?? {}) as Record<string, unknown>;
  // A `verdict` field marks an on-chain intel report; otherwise it's a general
  // task deliverable (summary + optional result_url).
  const isReport = typeof p.verdict === "string";
  const result_url = (typeof p.result_url === "string" && p.result_url) || `inline://${result_hash.slice(0, 16)}`;
  const reqBody = isReport
    ? { result_hash, result_url, report: payload }
    : { result_hash, result_url, summary: typeof p.summary === "string" ? p.summary : "completed" };
  const res = await fetch(`${cfg.apiUrl}/tasks/${id}/submit`, {
    method: "POST",
    headers: authed(token),
    body: JSON.stringify(reqBody),
  });
  if (!res.ok) throw new Error(`/tasks/${id}/submit ${res.status}: ${await res.text()}`);
}

// --------------------------------------------------- file handoff with local LLM
async function handoffToLocalAgent(cfg: WorkerConfig, task: TaskRow, deadlineMs: number): Promise<unknown> {
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

  // Poll for the outbox file.
  const pollInterval = 2000;
  while (Date.now() < deadlineMs) {
    try {
      const raw = await fs.readFile(outboxPath, "utf-8");
      const parsed = JSON.parse(raw);
      log(`outbox/${task.id}.json picked up.`);
      // Clean up.
      await fs.unlink(inboxPath).catch(() => {});
      await fs.unlink(outboxPath).catch(() => {});
      return parsed;
    } catch {
      // not yet - keep waiting
    }
    await sleep(pollInterval);
  }
  await fs.unlink(inboxPath).catch(() => {});
  throw new Error("submit_deadline_exceeded");
}

// -------------------------------------------------------------------- loop
export async function startWorker(cfg: WorkerConfig, defaultHandler: (task: TaskRow) => Promise<unknown>): Promise<void> {
  const { token: initialToken, account } = await authenticate(cfg);
  let token = initialToken;
  if (account) log(`agent address: ${account.address}`);
  if (cfg.apiKey) log("auth: AGORA_API_KEY");
  log(`api: ${cfg.apiUrl} | caps: [${cfg.caps.join(", ")}] | chain: ${cfg.chain || "any"} | auto: ${cfg.auto}`);

  log(cfg.apiKey ? "logged in (API key)" : "logged in (SIWE)");

  // Make sure inbox/outbox dirs exist up-front in file-handoff mode.
  if (!cfg.auto) {
    await fs.mkdir(cfg.inbox, { recursive: true });
    await fs.mkdir(cfg.outbox, { recursive: true });
  }

  while (true) {
    try {
      const open = await pollOpen(cfg, token);
      for (const task of open) {
        const won = await claim(cfg, token, task.id);
        if (!won) continue;
        log(`claimed ${task.id} (${task.kind} on ${task.chain} -> ${task.target_address})`);
        try {
          const deadline = won.submit_deadline ?? Date.now() + 10 * 60_000;
          const report = cfg.auto ? await defaultHandler(won) : await handoffToLocalAgent(cfg, won, deadline);
          await submit(cfg, token, task.id, report);
          log(`submitted ${task.id} - settled, payout received.`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log(`${task.id} failed: ${msg}`);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`poll error: ${msg}`);
      // re-auth on 401-ish errors
      if (msg.includes("401")) {
        if (account) {
          log("re-authenticating...");
          try { token = await login(cfg, account); } catch (ee) { log(`re-auth failed: ${ee}`); }
        } else {
          log("API key rejected; create a fresh key in the AGORA web app.");
        }
      }
    }
    await sleep(cfg.pollMs);
  }
}
