export interface BackoffRange {
  minMs: number;
  maxMs: number;
}

/**
 * Exponential backoff `min * 2^attempt` capped at `max`, with ±25 % jitter so clients that failed
 * together do not retry in lockstep. `random` is a uniform [0, 1) source (crypto-backed in the app).
 */
export function exponentialBackoff(attempt: number, random: () => number, range: BackoffRange): number {
  const exponent = Math.min(Math.max(0, Math.floor(attempt)), 30);
  const base = Math.min(range.maxMs, range.minMs * 2 ** exponent);
  const jittered = base * (0.75 + 0.5 * random());
  return Math.round(Math.min(range.maxMs, Math.max(range.minMs, jittered)));
}
