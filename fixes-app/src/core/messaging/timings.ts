import type { BackoffRange } from '../utils/backoff';

/** Every delay of the engine, with the protocol's values as defaults (tests shorten them). */
export interface MessagingTimings {
  /** §7.2: receipts are coalesced per (peer, status) with ~1 s debounce. */
  receiptDebounceMs: number;
  /** §13: send retries 1 s → 5 min. */
  outboxBackoff: BackoffRange;
  /** Receive retries after a transient failure (same curve as the socket, §6). */
  receiveBackoff: BackoffRange;
  /** §8: device lists are cached for 60 s per user. */
  deviceCacheTtlMs: number;
  /** §13: peer profiles are refreshed at most once a minute. */
  peerRefreshIntervalMs: number;
  /** Envelopes per `GET /v1/envelopes` page (1..500). */
  pageSize: number;
  /** §9: 30 min to the first chunk, then 10 min of inactivity. */
  transferFirstChunkMs: number;
  transferInactivityMs: number;
  transferCheckIntervalMs: number;
  /** History envelopes per POST (each up to ~87 KB of base64; the request limit is 9 MiB). */
  historyBatchSize: number;
  /** §12.2: receipt hints are pruned after 30 days. */
  receiptHintTtlMs: number;
}

export const DEFAULT_MESSAGING_TIMINGS: MessagingTimings = {
  receiptDebounceMs: 1_000,
  outboxBackoff: { minMs: 1_000, maxMs: 300_000 },
  receiveBackoff: { minMs: 1_000, maxMs: 30_000 },
  deviceCacheTtlMs: 60_000,
  peerRefreshIntervalMs: 60_000,
  pageSize: 100,
  transferFirstChunkMs: 30 * 60_000,
  transferInactivityMs: 10 * 60_000,
  transferCheckIntervalMs: 30_000,
  historyBatchSize: 20,
  receiptHintTtlMs: 30 * 24 * 60 * 60_000,
};
