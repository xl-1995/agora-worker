import { describe, it, expect } from "vitest";
import { pct, mapSafety, computeVerdict, type SafetyFact, type GoPlusToken } from "../src/default-handler.js";

describe("pct", () => {
  it("treats fractions <=1 as a percentage", () => {
    expect(pct("0.05")).toBe(5);
    expect(pct("1")).toBe(100);
  });
  it("passes through values already in percent", () => {
    expect(pct("12")).toBe(12);
    expect(pct("100")).toBe(100);
  });
  it("returns 0 for empty / missing / non-numeric input", () => {
    expect(pct(undefined)).toBe(0);
    expect(pct("")).toBe(0);
    expect(pct("abc")).toBe(0);
  });
});

describe("computeVerdict", () => {
  const fact = (status: SafetyFact["status"]): SafetyFact => ({ key: "k", status, value: "v" });
  it("low when nothing is wrong", () => {
    expect(computeVerdict([fact("pass"), fact("pass")])).toBe("low");
  });
  it("medium at 3+ warnings, no dangers", () => {
    expect(computeVerdict([fact("warn"), fact("warn"), fact("warn")])).toBe("medium");
    expect(computeVerdict([fact("warn"), fact("warn")])).toBe("low");
  });
  it("high at 1-2 dangers", () => {
    expect(computeVerdict([fact("danger")])).toBe("high");
    expect(computeVerdict([fact("danger"), fact("danger")])).toBe("high");
  });
  it("critical at 3+ dangers regardless of warnings", () => {
    expect(computeVerdict([fact("danger"), fact("danger"), fact("danger")])).toBe("critical");
  });
});

describe("mapSafety", () => {
  it("flags a honeypot as danger and drives a high verdict", () => {
    const t: GoPlusToken = { is_honeypot: "1", is_open_source: "1" };
    const safety = mapSafety(t);
    expect(safety.find((f) => f.key === "honeypot")?.status).toBe("danger");
    expect(computeVerdict(safety)).toBe("high");
  });

  it("rates a clean, verified, locked token as low risk", () => {
    const t: GoPlusToken = {
      is_honeypot: "0",
      is_mintable: "0",
      is_open_source: "1",
      buy_tax: "0",
      sell_tax: "0",
      lp_holders: [{ percent: "0.9", is_locked: 1 }],
      holders: [{ percent: "0.1" }, { percent: "0.1" }],
    };
    expect(computeVerdict(mapSafety(t))).toBe("low");
  });

  it("treats unknown boolean fields as a warning", () => {
    expect(mapSafety({}).find((f) => f.key === "honeypot")?.status).toBe("warn");
  });

  it("escalates tax above 10% to danger", () => {
    const t: GoPlusToken = { buy_tax: "0.15", sell_tax: "0" };
    expect(mapSafety(t).find((f) => f.key === "tax")?.status).toBe("danger");
  });

  it("marks unlocked LP as danger", () => {
    const t: GoPlusToken = { lp_holders: [{ percent: "0.9", is_locked: 0 }] };
    expect(mapSafety(t).find((f) => f.key === "lpLocked")?.status).toBe("danger");
  });
});
