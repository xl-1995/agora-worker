import { describe, it, expect } from "vitest";
import { validateDeliverable } from "../src/validate.js";
import type { TaskRow } from "../src/worker.js";

const baseTask = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: "t1",
  publisher_id: "p1",
  kind: "general",
  category: null,
  title: "Do a thing",
  description: null,
  chain: null,
  target_address: null,
  params: "{}",
  reward_agio: 10,
  agent_bond_agio: 1,
  status: "claimed",
  claimed_agent_id: "a1",
  claim_deadline: null,
  submit_deadline: null,
  created_at: 0,
  ...over,
});

const onChainTask = () => baseTask({ kind: "intel.deep", target_address: "0xabc", chain: "bsc" });

const goodReport = () => ({
  verdict: "low",
  safety: [{ key: "honeypot", status: "pass", value: "Sellable" }],
  fund_flow: [{ title: "Funding", detail: "From CEX", flag: "info" }],
  smart_money: [],
  deployer: { address: "0x1", priorTokens: 0, rugCount: 0 },
  assessment: ["No red flags."],
  sources: [{ label: "BscScan", url: "https://bscscan.com/address/0xabc" }],
});

describe("validateDeliverable — general task", () => {
  it("accepts a real summary", () => {
    const r = validateDeliverable({ summary: "Translated 2,043 words EN→JA." }, baseTask());
    expect(r.errors).toEqual([]);
  });
  it("rejects a missing summary", () => {
    expect(validateDeliverable({}, baseTask()).errors.length).toBeGreaterThan(0);
  });
  it('rejects the "completed" placeholder as no result', () => {
    expect(validateDeliverable({ summary: "completed" }, baseTask()).errors.length).toBeGreaterThan(0);
  });
  it("warns on a bare one-liner with no body or link", () => {
    const r = validateDeliverable({ summary: "Done." }, baseTask());
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.includes("one-line"))).toBe(true);
  });
  it("rejects a non-array attachments field", () => {
    const r = validateDeliverable({ summary: "x", body: "## y", attachments: "nope" }, baseTask());
    expect(r.errors.some((e) => e.includes("attachments"))).toBe(true);
  });
});

describe("validateDeliverable — on-chain report", () => {
  it("accepts a well-formed report", () => {
    expect(validateDeliverable(goodReport(), onChainTask()).errors).toEqual([]);
  });
  it("rejects a missing required field", () => {
    const { sources, ...rest } = goodReport();
    void sources;
    expect(validateDeliverable(rest, onChainTask()).errors.some((e) => e.includes("sources"))).toBe(true);
  });
  it("rejects a bad verdict", () => {
    expect(validateDeliverable({ ...goodReport(), verdict: "scary" }, onChainTask()).errors.length).toBeGreaterThan(0);
  });
  it("rejects an empty sources array", () => {
    const r = validateDeliverable({ ...goodReport(), sources: [] }, onChainTask());
    expect(r.errors.some((e) => e.includes("at least one"))).toBe(true);
  });
  it("rejects a safety fact with a bad status", () => {
    const bad = { ...goodReport(), safety: [{ key: "honeypot", status: "scary", value: "x" }] };
    expect(validateDeliverable(bad, onChainTask()).errors.some((e) => e.includes("status"))).toBe(true);
  });
});

describe("validateDeliverable — secret leakage", () => {
  it("blocks an AGORA API key", () => {
    const key = "agk_" + "a".repeat(64);
    const r = validateDeliverable({ summary: `key is ${key}` }, baseTask());
    expect(r.errors.some((e) => e.includes("API key"))).toBe(true);
  });
  it("warns on a leaked local path", () => {
    const r = validateDeliverable({ summary: "ok", body: "see C:\\Users\\me\\secret.txt" }, baseTask());
    expect(r.warnings.some((w) => w.includes("local"))).toBe(true);
  });
  it("does not false-positive on a normal contract address", () => {
    const r = validateDeliverable(goodReport(), onChainTask());
    expect(r.errors).toEqual([]);
  });
});
