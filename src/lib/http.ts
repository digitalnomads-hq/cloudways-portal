// Shared HTTP helper for the external APIs this portal talks to (Cloudways +
// WordPress REST). Both are intermittently flaky — Cloudways returns 502/429
// under load, and a freshly-cloned WP site serves 502/503 while PHP-FPM warms
// up. Node's fetch has no default timeout, so a hung connection would otherwise
// stall a clone indefinitely.

export interface RetryOptions {
  /** Per-attempt timeout in ms. */
  timeoutMs?: number;
  /** Number of retries after the first attempt. */
  retries?: number;
  /** Base delay for exponential backoff in ms. */
  backoffMs?: number;
  /** Called before each retry, for progress reporting. */
  onRetry?: (attempt: number, reason: string) => void;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch with a per-attempt timeout and bounded retries on transient failures.
 *
 * Retries on network errors, timeouts, and the status codes in RETRYABLE_STATUS.
 * A 4xx that isn't 408/425/429 is returned as-is — those are our bug, not a blip,
 * and retrying only delays the real error.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: RetryOptions = {},
): Promise<Response> {
  const { timeoutMs = 30000, retries = 3, backoffMs = 1000, onRetry } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff with a cap, so a slow API doesn't blow the budget.
      await sleep(Math.min(backoffMs * 2 ** (attempt - 1), 15000));
    }

    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });

      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        onRetry?.(attempt + 1, `HTTP ${res.status}`);
        continue;
      }

      return res;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        const reason = err instanceof Error ? err.message : String(err);
        onRetry?.(attempt + 1, reason);
        continue;
      }
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Request to ${url} failed after ${retries + 1} attempts: ${reason}`);
}

/**
 * Body-carrying requests are not always safe to retry — but every call site in
 * this app is either idempotent (settings writes, plugin state) or guarded by a
 * pre-check, so the default above applies. Use this when a POST genuinely must
 * only ever be attempted once (e.g. app/clone).
 */
export function fetchOnce(url: string, init: RequestInit = {}, timeoutMs = 30000): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
