/**
 * Shared HTTP helper: per-request timeout, bounded retry with backoff on
 * transient failures (network errors + 5xx), and a structured HttpError so
 * callers can branch on the status code instead of substring-matching messages.
 */

export class HttpError extends Error {
  constructor(public status: number, public url: string, public body: string) {
    super(`${url} ${status}: ${body}`);
    this.name = "HttpError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FetchOpts {
  timeoutMs?: number;
  retries?: number;
}

/**
 * fetch() with a timeout and retry-on-transient. 4xx responses are returned as-is
 * (callers decide what a 409/401 means); only network errors and 5xx are retried.
 */
export async function httpFetch(url: string | URL, init: RequestInit = {}, opts: FetchOpts = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status >= 500 && attempt < retries) {
        await sleep(backoff(attempt));
        continue;
      }
      return res;
    } catch (e) {
      if (attempt < retries) {
        await sleep(backoff(attempt));
        continue;
      }
      throw e;
    }
  }
}

/** httpFetch + JSON parse; throws HttpError on a non-2xx response. */
export async function fetchJson<T>(url: string | URL, init: RequestInit = {}, opts: FetchOpts = {}): Promise<T> {
  const res = await httpFetch(url, init, opts);
  if (!res.ok) throw new HttpError(res.status, String(url), await res.text().catch(() => ""));
  return (await res.json()) as T;
}

/** Exponential backoff with jitter: ~0.5s, ~1s, ~2s, capped at 5s. */
function backoff(attempt: number): number {
  const base = Math.min(500 * 2 ** attempt, 5_000);
  return base + Math.floor(base * 0.2 * Math.random());
}
