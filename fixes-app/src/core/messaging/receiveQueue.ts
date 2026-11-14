import { ApiError, isSignedOutError, isTransientError } from '../api/errors';
import type { Envelope, GetEnvelopesResponse } from '../api/types';
import type { Logger } from '../logger';
import { exponentialBackoff, type BackoffRange } from '../utils/backoff';
import { BoundedSet } from '../utils/boundedSet';
import { SerialQueue } from '../utils/serialQueue';
import type { ProcessResult } from './envelopeProcessor';

/**
 * The single receive queue of protocol §13. On socket `ready`: buffer pushed envelopes, drain
 * `GET /v1/envelopes` page by page until empty (each page applied in one transaction, then acked),
 * then process the buffered pushes, skipping ids already applied this session. Only one drain runs at
 * a time. A transient failure stops the queue without acking and retries the drain with backoff.
 */

export interface ReceiveApi {
  getEnvelopes(limit?: number): Promise<GetEnvelopesResponse>;
  ackEnvelopes(ids: string[]): Promise<void>;
}

export interface ReceiveQueueOptions {
  api: ReceiveApi;
  processor: { process(envelopes: readonly Envelope[]): Promise<ProcessResult> };
  logger: Logger;
  random: () => number;
  pageSize: number;
  backoff: BackoffRange;
  onGap(): void;
  onProcessed(result: ProcessResult): void;
  onSyncing(syncing: boolean): void;
}

type DrainOutcome = { ok: true } | { ok: false; error: unknown };

const MAX_ACK_IDS = 500;
const APPLIED_MEMORY = 10_000;

export class ReceiveQueue {
  private readonly queue = new SerialQueue();
  private readonly applied = new BoundedSet(APPLIED_MEMORY);
  // Pushes are buffered until a drain has completed: until then the mailbox may hold older envelopes.
  private buffering = true;
  private buffer: Envelope[] = [];
  private pending: Envelope[] = [];
  private pendingScheduled = false;
  private queuedDrain: Promise<DrainOutcome> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = false;

  constructor(private readonly options: ReceiveQueueOptions) {}

  /** Socket authenticated (§6 `ready`): report a gap and drain. */
  onReady(gap: boolean): void {
    if (this.stopped) return;
    if (gap) this.options.onGap();
    void this.requestDrain();
  }

  onPush(envelope: Envelope): void {
    if (this.stopped) return;
    if (this.buffering) {
      this.buffer.push(envelope);
      return;
    }
    this.pending.push(envelope);
    this.schedulePending();
  }

  /** Drains the mailbox now and resolves when done (used before linking and logout). Throws on failure. */
  async drain(): Promise<void> {
    const outcome = await this.requestDrain();
    if (!outcome.ok) throw outcome.error;
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.buffer = [];
    this.pending = [];
  }

  private requestDrain(): Promise<DrainOutcome> {
    this.buffering = true;
    // A drain that has not started yet will see everything a new request would.
    if (this.queuedDrain) return this.queuedDrain;
    const drain: Promise<DrainOutcome> = this.queue.run(async () => {
      if (this.queuedDrain === drain) this.queuedDrain = null;
      try {
        await this.drainTask();
        return { ok: true } as const;
      } catch (error) {
        this.onFailure(error);
        return { ok: false, error } as const;
      }
    });
    this.queuedDrain = drain;
    return drain;
  }

  private async drainTask(): Promise<void> {
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.buffering = true;
    this.options.onSyncing(true);
    try {
      for (;;) {
        const page = await this.options.api.getEnvelopes(this.options.pageSize);
        if (this.stopped) return;
        if (page.gap) this.options.onGap();
        if (page.envelopes.length === 0) break;
        await this.processBatch(page.envelopes);
      }
      this.buffering = false;
      const buffered = this.buffer.splice(0);
      for (let i = 0; i < buffered.length && !this.stopped; i += this.options.pageSize) {
        await this.processBatch(buffered.slice(i, i + this.options.pageSize));
      }
      this.attempt = 0;
    } finally {
      this.options.onSyncing(false);
    }
  }

  private schedulePending(): void {
    if (this.pendingScheduled) return;
    this.pendingScheduled = true;
    void this.queue
      .run(async () => {
        this.pendingScheduled = false;
        if (this.stopped) return;
        const batch = this.pending.splice(0);
        if (this.buffering) {
          // A drain was requested meanwhile; it processes these after the mailbox.
          this.buffer.push(...batch);
          return;
        }
        for (let i = 0; i < batch.length && !this.stopped; i += this.options.pageSize) {
          await this.processBatch(batch.slice(i, i + this.options.pageSize));
        }
      })
      .catch((error: unknown) => this.onFailure(error));
  }

  /** Applies one page and acks it. Throws (after acking the handled prefix) when processing stopped early. */
  private async processBatch(envelopes: readonly Envelope[]): Promise<void> {
    const ackIds: string[] = [];
    const fresh: Envelope[] = [];
    const seen = new Set<string>();
    for (const envelope of envelopes) {
      if (seen.has(envelope.id)) continue;
      seen.add(envelope.id);
      if (this.applied.has(envelope.id)) ackIds.push(envelope.id);
      else fresh.push(envelope);
    }
    let stoppedBy: unknown = null;
    if (fresh.length > 0) {
      const result = await this.options.processor.process(fresh);
      for (const id of result.handledIds) {
        this.applied.add(id);
        ackIds.push(id);
      }
      this.options.onProcessed(result);
      stoppedBy = result.stoppedBy;
    }
    for (let i = 0; i < ackIds.length; i += MAX_ACK_IDS) {
      if (this.stopped) return;
      await this.options.api.ackEnvelopes(ackIds.slice(i, i + MAX_ACK_IDS));
    }
    if (stoppedBy !== null) throw stoppedBy;
  }

  private onFailure(error: unknown): void {
    if (this.stopped) return;
    // Pushes received from now on wait for the retry drain (the mailbox still holds what failed).
    this.buffering = true;
    if (isSignedOutError(error)) return; // The session layer signs out and stops the engine.
    const rateLimited = error instanceof ApiError && error.code === 'rate_limited';
    if (isTransientError(error)) this.options.logger.warn('Receiving paused after a network error; will retry', error);
    else if (rateLimited) this.options.logger.warn('Receiving paused by a rate limit; will retry', error);
    else this.options.logger.error('Receiving failed; will retry', error);
    const backoff = exponentialBackoff(this.attempt++, this.options.random, this.options.backoff);
    const delay = rateLimited ? Math.max(backoff, (error.retryAfter ?? 0) * 1000) : backoff;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.requestDrain();
    }, delay);
  }
}
