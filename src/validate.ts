/**
 * Pre-submit self-check. The worker refuses to submit a deliverable that fails
 * its own acceptance shape — garbage is stopped at the source instead of being
 * caught (and slashed) by the marketplace later.
 *
 * `errors` block submission; `warnings` are surfaced but still submit. The intel
 * rules mirror skills/agora-agent/scripts/validate_report.py so the worker and
 * the agent agree on the same bar.
 */

import type { TaskRow } from "./worker.js";

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

const VERDICTS = new Set(["low", "medium", "high", "critical"]);
const SAFETY_STATUSES = new Set(["pass", "warn", "danger", "info"]);
const FLOW_FLAGS = new Set(["danger", "warn", "info"]);
const REPORT_REQUIRED = ["verdict", "safety", "fund_flow", "smart_money", "deployer", "assessment", "sources"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** Validate a deliverable against the shape its task requires (on-chain vs general). */
export function validateDeliverable(payload: unknown, task: TaskRow): ValidationResult {
  const r: ValidationResult = { errors: [], warnings: [] };
  if (!isObject(payload)) {
    r.errors.push("deliverable must be a JSON object");
    return r;
  }
  if (task.target_address) validateReport(payload, r);
  else {
    validateGeneral(payload, r);
    checkRelevance(payload, task, r);
  }
  scanForSecrets(payload, r);
  return r;
}

// ----------------------------------------------------------- on-chain report
function validateReport(d: Record<string, unknown>, r: ValidationResult): void {
  const missing = REPORT_REQUIRED.filter((k) => !(k in d));
  if (missing.length) {
    r.errors.push(`report missing required field(s): ${missing.join(", ")}`);
    return; // shape is too broken to keep checking
  }

  if (!VERDICTS.has(d.verdict as string)) r.errors.push(`bad verdict: ${JSON.stringify(d.verdict)}`);

  for (const key of ["safety", "fund_flow", "smart_money", "assessment", "sources"]) {
    if (!Array.isArray(d[key])) r.errors.push(`${key} must be an array`);
  }
  if (!isObject(d.deployer)) r.errors.push("deployer must be an object");

  if (Array.isArray(d.safety)) {
    d.safety.forEach((f, i) => {
      if (!isObject(f)) return r.errors.push(`safety[${i}] must be an object`);
      for (const k of ["key", "status", "value"]) if (!(k in f)) r.errors.push(`safety[${i}] missing ${k}`);
      if ("status" in f && !SAFETY_STATUSES.has(f.status as string)) r.errors.push(`safety[${i}] bad status: ${JSON.stringify(f.status)}`);
    });
    if (d.safety.length === 0) r.warnings.push("safety has no facts — a deep report should list checks");
  }

  if (Array.isArray(d.fund_flow)) {
    d.fund_flow.forEach((s, i) => {
      if (!isObject(s)) return r.errors.push(`fund_flow[${i}] must be an object`);
      for (const k of ["title", "detail", "flag"]) if (!(k in s)) r.errors.push(`fund_flow[${i}] missing ${k}`);
      if ("flag" in s && !FLOW_FLAGS.has(s.flag as string)) r.errors.push(`fund_flow[${i}] bad flag: ${JSON.stringify(s.flag)}`);
    });
  }

  if (Array.isArray(d.sources)) {
    d.sources.forEach((s, i) => {
      if (!isObject(s)) return r.errors.push(`sources[${i}] must be an object`);
      if (!nonEmptyStr(s.label) || !nonEmptyStr(s.url)) r.errors.push(`sources[${i}] requires a label and url`);
    });
    if (d.sources.length === 0) r.errors.push("sources must contain at least one entry");
  }

  if (Array.isArray(d.assessment) && d.assessment.length === 0) {
    r.warnings.push("assessment is empty — state the main reason for the verdict");
  }
}

// --------------------------------------------------------------- general task
function validateGeneral(d: Record<string, unknown>, r: ValidationResult): void {
  // submit() falls back to "completed" when summary is missing — treat that as no result.
  if (!nonEmptyStr(d.summary) || d.summary.trim() === "completed") {
    r.errors.push("general task requires a real, non-empty summary");
  }

  if ("body" in d && d.body !== undefined && typeof d.body !== "string") {
    r.errors.push("body must be a Markdown string");
  }
  if ("result_url" in d && d.result_url !== undefined && !nonEmptyStr(d.result_url)) {
    r.errors.push("result_url must be a non-empty string when present");
  }
  if (nonEmptyStr(d.result_url) && !/^https?:\/\//i.test(d.result_url) && !d.result_url.startsWith("inline://")) {
    r.warnings.push("result_url does not look like an http(s) link");
  }

  if ("attachments" in d && d.attachments !== undefined) {
    if (!Array.isArray(d.attachments)) r.errors.push("attachments must be an array of url strings");
    else if (d.attachments.some((a) => typeof a !== "string")) {
      r.warnings.push("some attachments are not strings and will be dropped on submit");
    }
  }

  // Quality nudge: a bare one-liner with no body and no link is thin work.
  const hasBody = nonEmptyStr(d.body);
  const hasLink = nonEmptyStr(d.result_url);
  if (nonEmptyStr(d.summary) && !hasBody && !hasLink) {
    r.warnings.push("deliverable is a one-line summary with no body or result_url — consider a Markdown body");
  }
}

// ----------------------------------------------------- answer ↔ question match
//
// A deterministic relevance gate: shape can be perfect while the answer ignores
// the question. We can't *judge* semantic quality without a model, but we can
// cheaply catch the gross mismatches — refusals, echoes of the prompt, and
// acceptance criteria the deliverable never touches. These are warnings (with
// one error for a blatant non-answer) so a false positive never blocks good work.

const REFUSAL =
  /\b(?:i (?:cannot|can'?t|am unable|was unable|won'?t|could not|couldn'?t)|as an ai|i (?:do|don'?t) (?:not )?have access|unable to (?:complete|access|provide)|insufficient (?:data|information|context) to|无法(?:完成|提供|访问)|不能完成)\b/i;

// Small English stopword set so term-overlap keys on meaningful words.
const STOPWORDS = new Set(
  ("the a an and or of to in on for with from into over under this that these those is are was were be been being it its as by at about your you our we they them their his her per via such not no any all each both than then so but if when while which who whom whose what why how also more most into onto out up down off here there".split(
    " ",
  )),
);

/** Meaningful Latin tokens (≥4 chars, not stopwords). Chinese is handled via substring. */
function salientTerms(s: string): string[] {
  const toks = s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
  return [...new Set(toks.filter((t) => !STOPWORDS.has(t)))];
}

function parseAcceptanceCriteria(task: TaskRow): string[] {
  try {
    const p = JSON.parse(task.params || "{}") as Record<string, unknown>;
    const ac = p.acceptance_criteria;
    if (Array.isArray(ac)) return ac.filter((x): x is string => typeof x === "string");
    if (typeof ac === "string" && ac.trim()) return [ac.trim()];
  } catch {
    /* params not JSON — no criteria to check */
  }
  return [];
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, " ").trim();

function checkRelevance(d: Record<string, unknown>, task: TaskRow, r: ValidationResult): void {
  const summary = typeof d.summary === "string" ? d.summary : "";
  const body = typeof d.body === "string" ? d.body : "";
  const text = `${summary}\n${body}`;
  const textLower = text.toLowerCase();
  const hasBody = nonEmptyStr(body);
  const hasLink = nonEmptyStr(d.result_url);

  // Blatant non-answer: a short deliverable that reads as a refusal did no work.
  if (REFUSAL.test(text) && text.trim().length < 400) {
    r.errors.push("deliverable reads as a refusal / non-answer, not completed work");
  }

  // Echo: the summary just restates the task title and there's no body.
  if (nonEmptyStr(task.title) && !hasBody && norm(summary) === norm(task.title)) {
    r.warnings.push("summary just restates the task title — give the actual result, not the question");
  }

  // We can only inspect inline text. If the real work is behind result_url, skip
  // coverage checks rather than warn on content we can't see.
  const canInspect = hasBody || (!hasLink && nonEmptyStr(summary));
  if (!canInspect) return;

  // Acceptance criteria: warn on any criterion the deliverable plainly ignores.
  const criteria = parseAcceptanceCriteria(task);
  for (const c of criteria) {
    if (!addressesCriterion(c, text, textLower)) {
      const label = c.length > 60 ? c.slice(0, 57) + "…" : c;
      r.warnings.push(`deliverable may not satisfy acceptance criterion: "${label}"`);
    }
  }

  // No explicit criteria → fall back to term overlap with the task's own wording.
  if (criteria.length === 0) {
    const terms = salientTerms(`${task.title ?? ""} ${task.description ?? ""}`);
    if (terms.length >= 4) {
      const hit = terms.filter((t) => textLower.includes(t)).length;
      if (hit / terms.length < 0.25) {
        r.warnings.push("deliverable has low term overlap with the task — it may not address the ask");
      }
    }
  }
}

/** Heuristic: does the deliverable plausibly address one acceptance criterion? */
function addressesCriterion(c: string, text: string, textLower: string): boolean {
  const cl = c.toLowerCase();
  // A structural criterion is judged purely structurally: present → satisfied.
  if (/\btables?\b|表格/.test(cl)) return /\|.*\|/.test(text);
  if (/\b(?:cite|citations?|sources?|references?)\b|来源|引用|出处/.test(cl)) return /https?:\/\//.test(text);

  // Otherwise: does the deliverable cover the criterion's meaningful terms?
  const terms = salientTerms(c);
  if (terms.length === 0) return textLower.includes(cl.trim()); // Chinese/short → substring
  const hit = terms.filter((t) => textLower.includes(t)).length;
  return hit / terms.length >= 0.34;
}

// --------------------------------------------------------- secrets / leakage
const PEM_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const API_KEY = /\bagk_[a-fA-F0-9]{64}\b/;
// Windows paths get their backslashes doubled by JSON.stringify, so allow 1–2.
const LOCAL_PATH = /(?:[A-Za-z]:\\{1,2}Users\\{1,2}|\/home\/[^/\s]+\/|\/Users\/[^/\s]+\/)/;
const SECRET_ASSIGN = /\b(?:PRIVATE_KEY|API_KEY|SECRET|MNEMONIC)\b\s*[=:]\s*\S/i;

/** Catch the obvious leaks SKILL.md forbids: API keys, PEM keys, local paths, secret assignments. */
function scanForSecrets(payload: unknown, r: ValidationResult): void {
  const text = JSON.stringify(payload);
  if (API_KEY.test(text)) r.errors.push("deliverable appears to contain an AGORA API key (agk_…) — remove it");
  if (PEM_KEY.test(text)) r.errors.push("deliverable appears to contain a PEM private key — remove it");
  if (SECRET_ASSIGN.test(text)) r.warnings.push("deliverable looks like it assigns a secret (PRIVATE_KEY/API_KEY/…) — double-check");
  if (LOCAL_PATH.test(text)) r.warnings.push("deliverable contains a local filesystem path — strip machine-specific paths");
}
