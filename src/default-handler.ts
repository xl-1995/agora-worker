/**
 * Built-in `intel.deep` handler — for WORKER_AUTO=1 mode.
 *
 * No LLM required: produces a basic deep report from GoPlus's safety data
 * alone. Useful for end-to-end loop smoke tests before integrating your
 * own agent. Real agents replace this with their own analysis (file handoff
 * to Codex / Claude Code / Bitquery + Anthropic, etc.).
 */

import type { TaskRow } from "./worker";

const GOPLUS_CHAIN_IDS: Record<string, string> = {
  bsc: "56",
  ethereum: "1",
  arbitrum: "42161",
  base: "8453",
};

export async function defaultIntelDeepHandler(task: TaskRow): Promise<unknown> {
  if (!task.chain || !task.target_address) throw new Error("auto handler only supports on-chain intel tasks");
  const target = task.target_address.toLowerCase();
  const chainId = GOPLUS_CHAIN_IDS[task.chain] ?? "56";
  const url = `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${target}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`goplus ${res.status}`);
  const data = (await res.json()) as { code: number; message: string; result?: Record<string, GoPlusToken> };
  if (data.code !== 1 || !data.result) throw new Error(`goplus: ${data.message}`);
  const t = data.result[target];
  if (!t) throw new Error("goplus: token not indexed");

  const safety = mapSafety(t);
  const dangers = safety.filter((f) => f.status === "danger").length;
  const warns = safety.filter((f) => f.status === "warn").length;
  const verdict =
    dangers >= 3 ? "critical" : dangers >= 1 ? "high" : warns >= 3 ? "medium" : "low";

  return {
    token_name: t.token_name,
    token_symbol: t.token_symbol,
    verdict,
    safety,
    // Auto-mode placeholders for Layer-2 fields — real agents fill these in.
    fund_flow: [
      { title: "Auto-mode: fund-flow analysis skipped", detail: "Use file-handoff mode with your own agent to populate this.", flag: "info" },
    ],
    smart_money: [],
    deployer: { address: "—", priorTokens: 0, rugCount: 0, note: "Auto-mode: deployer history not analyzed." },
    assessment: [
      `Auto-mode safety scan (${dangers} danger / ${warns} warn).`,
      "For full deep intelligence (fund tracing, smart money, deployer history), run a real agent on this task via the file-handoff inbox/outbox.",
    ],
    sources: [
      { label: "GoPlus Security — token safety", url: `https://gopluslabs.io/token-security/${chainId}/${task.target_address}` },
    ],
  };
}

// ---------------------------------------------------------------- internal
interface GoPlusToken {
  token_name?: string;
  token_symbol?: string;
  is_honeypot?: string;
  is_mintable?: string;
  can_take_back_ownership?: string;
  hidden_owner?: string;
  owner_change_balance?: string;
  is_blacklisted?: string;
  buy_tax?: string;
  sell_tax?: string;
  is_open_source?: string;
  lp_holders?: { percent?: string; is_locked?: number }[];
  holders?: { percent?: string }[];
}

function mapSafety(t: GoPlusToken) {
  const out: { key: string; status: "pass" | "warn" | "danger"; value: string }[] = [];
  out.push(boolFact("honeypot", t.is_honeypot, "Sellable", "Honeypot detected"));
  out.push(boolFact("mintable", t.is_mintable, "No mint function", "Owner can mint"));
  const privs = [t.can_take_back_ownership, t.hidden_owner, t.owner_change_balance, t.is_blacklisted].some((v) => v === "1");
  out.push({ key: "ownerPrivileges", status: privs ? "danger" : "pass", value: privs ? "Risky privileges present" : "No risky privileges" });
  const bt = pct(t.buy_tax), st = pct(t.sell_tax);
  out.push({ key: "tax", status: bt > 10 || st > 10 ? "danger" : bt > 5 || st > 5 ? "warn" : "pass", value: `Buy ${bt}% / Sell ${st}%` });
  const lpLocked = (t.lp_holders ?? []).filter((h) => Number(h.is_locked) === 1).reduce((s, h) => s + pct(h.percent), 0);
  out.push({ key: "lpLocked", status: lpLocked >= 80 ? "pass" : lpLocked > 0 ? "warn" : "danger", value: lpLocked > 0 ? `${Math.round(lpLocked)}% locked` : "Not locked" });
  out.push(boolFact("verified", t.is_open_source, "Source verified", "Source not verified"));
  const top10 = (t.holders ?? []).slice(0, 10).reduce((s, h) => s + pct(h.percent), 0);
  out.push({ key: "topHolders", status: top10 >= 75 ? "danger" : top10 >= 50 ? "warn" : "pass", value: top10 ? `Top 10 hold ${Math.round(top10)}%` : "Distribution unknown" });
  return out;
}

function boolFact(key: string, v: string | undefined, off: string, on: string): { key: string; status: "pass" | "warn" | "danger"; value: string } {
  if (v === "1") return { key, status: "danger", value: on };
  if (v === "0") return { key, status: "pass", value: off };
  return { key, status: "warn", value: "Unknown" };
}

function pct(v: string | undefined): number {
  if (v == null || v === "") return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n <= 1 ? n * 100 : n;
}
