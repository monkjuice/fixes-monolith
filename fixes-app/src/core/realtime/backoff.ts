export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;

/**
 * Exponential backoff 1 s → 30 s with ±25 % jitter (protocol §6). The jitter is kept at the cap so
 * many clients that lost the server at the same time do not reconnect in lockstep.
 */
export function backoffDelay(attempt: number, random: () => number): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt));
  const jittered = base * (0.75 + 0.5 * random());
  return Math.round(Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, jittered)));
}
