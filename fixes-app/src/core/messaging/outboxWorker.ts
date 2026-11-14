import { ApiError, isSignedOutError, isTransientError } from '../api/errors';
import type { OutgoingEnvelope, PostEnvelopesResponse } from '../api/types';
import { CryptoError } from '../crypto/errors';
import type { LocalStore } from '../db/localStore';
import { parseReceiptPayload as parseOutboxReceipt } from '../db/repositories/outbox';
import type { MessageRow, OutboxRow } from '../db/types';
import type { Logger } from '../logger';
import { PayloadError } from '../payloads/fields';
import { buildMessagePayload } from '../payloads/message';
import { buildReceiptPayload } from '../payloads/receipt';
import type { Clock } from '../platform';
import type { DeviceDirectory, EligibleDevice } from '../trust/deviceDirectory';
import { exponentialBackoff, type BackoffRange } from '../utils/backoff';
import { SerialQueue } from '../utils/serialQueue';
import type { EnvelopeCodec } from './envelopeCodec';

/**
 * The outbox worker of protocol §13 "Send". Runs when the socket is ready, on foreground, after
 * enqueue and when a scheduled retry is due. For each due row it resolves eligible devices (§8),
 * encrypts one envelope per device and POSTs them with `complete_for_user_ids`. Error classes:
 * network/5xx → retry with backoff (1 s → 5 min) and pause the queue; `stale_devices` → refresh the
 * device lists and retry once immediately; `not_friends`, a pending contact identity or no eligible
 * device → `failed`; `rate_limited` → wait for Retry-After; a local fault (storage) → in-memory backoff,
 * and a message whose POST went through is not POSTed again, only its local update is retried.
 */

export interface OutboxApi {
  postEnvelopes(envelopes: OutgoingEnvelope[], completeForUserIds?: string[]): Promise<PostEnvelopesResponse>;
}

/** A message that cannot be sent until the user acts (§13: shown as failed, tap to retry). */
export class SendBlockedError extends Error {
  constructor(readonly reason: 'identity_pending' | 'no_devices') {
    super(reason === 'identity_pending' ? "The contact's safety code changed" : 'The contact has no linked device');
    this.name = 'SendBlockedError';
  }
}

export interface OutboxWorkerOptions {
  store: LocalStore;
  api: OutboxApi;
  directory: DeviceDirectory;
  codec: EnvelopeCodec;
  self: { userId: string; deviceId: string };
  clock: Clock;
  random: () => number;
  logger: Logger;
  backoff: BackoffRange;
}

type Outcome = 'next' | 'halt';

const BATCH = 50;

function isStaleDevices(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'stale_devices';
}

/** Definitive refusals: retrying the same request can never succeed. */
function isPermanent(error: unknown): boolean {
  if (error instanceof SendBlockedError || error instanceof PayloadError || error instanceof CryptoError) return true;
  if (!(error instanceof ApiError)) return false;
  if (error.status >= 500 || error.status === 401 || error.status === 408 || error.status === 429) return false;
  if (error.code === 'stale_devices' || error.code === 'invalid_response') return false;
  return error.status >= 400;
}

export class OutboxWorker {
  private readonly queue = new SerialQueue();
  private stopped = true;
  private scheduled = false;
  private rerun = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pausedUntil = 0;
  /** 'local': a local fault (e.g. a full disk) escaped the loop; only time ends that pause. */
  private pauseReason: 'network' | 'rate' | 'local' | null = null;
  private lastHaltError: unknown = null;
  /** Local faults in a row since the last row that went through (exponential in-memory backoff). */
  private localFailures = 0;
  /**
   * Messages whose POST succeeded but whose local update failed, with the server time: the next
   * attempt only retries the update, since every POST adds a copy to each recipient's mailbox.
   */
  private readonly posted = new Map<string, number>();

  constructor(private readonly options: OutboxWorkerOptions) {}

  start(): void {
    this.stopped = false;
    this.kick();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  get running(): boolean {
    return !this.stopped;
  }

  /**
   * Runs the queue soon. `retryNow` (connectivity is back, the app came to the foreground, the user
   * acted) ends a network pause and makes backed-off rows due again; a rate-limit pause is kept.
   */
  kick(options: { retryNow?: boolean } = {}): void {
    if (this.stopped) return;
    if (options.retryNow && this.pauseReason !== 'rate' && this.pauseReason !== 'local') {
      this.pausedUntil = 0;
      this.pauseReason = null;
      void this.options.store.outbox
        .makeDue(this.options.clock.now(), { retriesOnly: true })
        .then(() => this.schedule())
        .catch((error: unknown) => this.report('Could not reschedule the outbox', error));
      return;
    }
    this.schedule();
  }

  /**
   * Logout (§13): attempts every row once, ignoring schedules and pauses, including rows queued while
   * it runs (receipts for envelopes still arriving). Throws on network errors (logout needs
   * connectivity); returns the number of rows still queued.
   */
  async flush(): Promise<number> {
    return this.queue.run(async () => {
      this.pausedUntil = 0;
      this.pauseReason = null;
      this.lastHaltError = null;
      const attempted = new Set<number>();
      for (;;) {
        const rows = (await this.options.store.outbox.listAll()).filter((row) => !attempted.has(row.id));
        if (rows.length === 0) break;
        let halted = false;
        for (const row of rows) {
          attempted.add(row.id);
          if ((await this.process(row)) === 'halt') {
            halted = true;
            break;
          }
        }
        if (halted) {
          const error = this.lastHaltError;
          if (isTransientError(error) || isSignedOutError(error)) throw error;
          break;
        }
      }
      return this.options.store.outbox.count();
    });
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.scheduled) {
      this.rerun = true;
      return;
    }
    this.scheduled = true;
    this.clearTimer();
    void this.queue
      .run(() => this.loop())
      .catch((error: unknown) => {
        this.report('Outbox worker failed', error);
        // A local fault escaped (e.g. the disk is full, so the row's new schedule was not stored either):
        // back off in memory rather than retrying the same row at once.
        const delay = exponentialBackoff(this.localFailures++, this.options.random, this.options.backoff);
        this.pause('local', this.options.clock.now() + delay, error);
      })
      .finally(() => {
        this.scheduled = false;
        if (this.rerun) {
          this.rerun = false;
          this.schedule();
        } else {
          void this.arm();
        }
      });
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const now = this.options.clock.now();
      if (now < this.pausedUntil) return;
      const due = await this.options.store.outbox.listDue(now, BATCH);
      if (due.length === 0) return;
      for (const row of due) {
        if (this.stopped) return;
        // Every path below deletes the row, reschedules it into the future or halts the loop.
        if ((await this.process(row)) === 'halt') return;
      }
    }
  }

  /** Arms a timer for the next scheduled attempt (backoff, debounce window or pause end). */
  private async arm(): Promise<void> {
    if (this.stopped) return;
    let next: number | null;
    try {
      next = await this.options.store.outbox.nextAttemptAt();
    } catch (error) {
      this.report('Could not read the outbox schedule', error);
      return;
    }
    if (next === null || this.stopped || this.scheduled) return;
    const at = Math.max(next, this.pausedUntil);
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.schedule();
    }, Math.max(0, at - this.options.clock.now()));
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async process(row: OutboxRow): Promise<Outcome> {
    try {
      if (row.kind === 'message') await this.sendMessage(row);
      else await this.sendReceipt(row);
      this.localFailures = 0;
      return 'next';
    } catch (error) {
      return this.handleError(row, error);
    }
  }

  private async sendMessage(row: OutboxRow): Promise<void> {
    const { store } = this.options;
    const message = row.message_id === null ? null : await store.messages.get(row.message_id);
    // A message still without a server time is sent even when a receipt already moved it past
    // `pending` (the answer to an earlier POST was lost): receivers ignore the duplicate, and its
    // server time is what orders it (§7.1, §13).
    if (!message || message.direction !== 'out' || message.status === 'failed' || message.server_ts !== null) {
      // Already sent, failed or gone: nothing left to do for this row.
      if (row.message_id !== null) this.posted.delete(row.message_id);
      await store.outbox.delete(row.id);
      return;
    }
    const peer = message.peer_user_id;
    const serverTs = this.posted.get(message.id) ?? (await this.postMessage(message));
    this.posted.set(message.id, serverTs);
    await store.transaction(async (tx) => {
      await tx.messages.markSent(message.id, serverTs);
      await tx.conversations.recomputeActivity(peer);
      await tx.outbox.delete(row.id);
    });
    this.posted.delete(message.id);
  }

  /** Encrypts and POSTs a message (§7.1); returns the server time of the envelopes. */
  private async postMessage(message: MessageRow): Promise<number> {
    const { directory, codec, self, api } = this.options;
    const peer = message.peer_user_id;
    const payload = buildMessagePayload({
      id: message.id,
      from: self.userId,
      to: peer,
      body: message.body,
      sentAt: message.sent_at,
    });
    const response = await this.withStaleRetry([peer, self.userId], async (refresh) => {
      const peerDevices = await directory.devicesFor(peer, { refresh });
      if (peerDevices.identity === 'pending') throw new SendBlockedError('identity_pending');
      if (peerDevices.devices.length === 0) throw new SendBlockedError('no_devices');
      const own = await directory.devicesFor(self.userId, { refresh });
      // §7.1: every linked device of the recipient and every other linked device of mine (sync copies).
      return api.postEnvelopes(codec.seal(payload, [...peerDevices.devices, ...own.devices]), [peer, self.userId]);
    });
    return Date.parse(response.created_at);
  }

  private async sendReceipt(queued: OutboxRow): Promise<void> {
    const { store, directory, codec, self, api, clock } = this.options;
    // Out of its coalescing window first, so queueReceipt cannot add ids to a payload that is already
    // being sent (the logout flush sends rows still inside the window).
    const row = await store.outbox.claimReceipt(queued.id);
    if (!row) return;
    const receipt = parseOutboxReceipt(row);
    if (!receipt) {
      this.options.logger.warn('Dropping a corrupt receipt row from the outbox');
      await store.outbox.delete(row.id);
      return;
    }
    const payload = buildReceiptPayload({
      status: receipt.status,
      peer: receipt.peer,
      messageIds: receipt.message_ids,
      at: clock.now(),
    });
    await this.withStaleRetry([receipt.peer, self.userId], async (refresh) => {
      const targets: EligibleDevice[] = [];
      const completeFor: string[] = [];
      const peerDevices = await this.peerDevicesForReceipt(receipt.peer, refresh);
      if (peerDevices.length > 0) {
        targets.push(...peerDevices);
        completeFor.push(receipt.peer);
      }
      // §7.2: read receipts also go to the reader's other devices (read sync).
      if (receipt.status === 'read') {
        const own = await directory.devicesFor(self.userId, { refresh });
        if (own.devices.length > 0) {
          targets.push(...own.devices);
          completeFor.push(self.userId);
        }
      }
      // Nobody to tell (e.g. the contact's new key awaits Accept and I have no other device).
      if (targets.length === 0) return null;
      return api.postEnvelopes(codec.seal(payload, targets), completeFor);
    });
    await store.outbox.delete(row.id);
  }

  /**
   * The peer's devices for a receipt. Receipts are informational: while the contact's new key awaits
   * acceptance nothing is sent to it, and a contact that is no longer a friend just gets no receipt.
   */
  private async peerDevicesForReceipt(peer: string, refresh: boolean): Promise<EligibleDevice[]> {
    try {
      const list = await this.options.directory.devicesFor(peer, { refresh });
      return list.identity === 'pinned' ? list.devices : [];
    } catch (error) {
      if (error instanceof ApiError && isPermanent(error)) return [];
      throw error;
    }
  }

  /** §13: on `stale_devices`, refresh the lists of the users involved and retry once immediately. */
  private async withStaleRetry<T>(users: string[], send: (refresh: boolean) => Promise<T>): Promise<T> {
    try {
      return await send(false);
    } catch (error) {
      if (!isStaleDevices(error)) throw error;
      this.options.directory.invalidate(...users);
      return send(true);
    }
  }

  private async handleError(row: OutboxRow, error: unknown): Promise<Outcome> {
    const { store, clock, logger } = this.options;
    const now = clock.now();
    if (isPermanent(error)) {
      if (row.kind === 'message' && row.message_id !== null) {
        const messageId = row.message_id;
        await store.transaction(async (tx) => {
          await tx.messages.markFailed(messageId);
          await tx.outbox.delete(row.id);
        });
      } else {
        await store.outbox.delete(row.id);
      }
      if (!(error instanceof SendBlockedError)) logger.warn(`Outbox ${row.kind} failed permanently`, error);
      return 'next';
    }
    if (isSignedOutError(error)) {
      this.lastHaltError = error;
      return 'halt';
    }
    if (error instanceof ApiError && error.code === 'rate_limited') {
      const until = now + Math.max(1, error.retryAfter ?? 60) * 1000;
      await store.outbox.reschedule(row.id, until);
      this.pause('rate', until, error);
      return 'halt';
    }
    const delay = exponentialBackoff(row.attempts, this.options.random, this.options.backoff);
    await store.outbox.reschedule(row.id, now + delay);
    if (isTransientError(error) || (error instanceof ApiError && error.status === 401)) {
      this.pause('network', now + delay, error);
      return 'halt';
    }
    // A second stale_devices in a row, a malformed answer or a local fault: retry this row later,
    // keep going with the others.
    logger.warn(`Outbox ${row.kind} will be retried`, error);
    return 'next';
  }

  private pause(reason: 'network' | 'rate' | 'local', until: number, error: unknown): void {
    this.pauseReason = reason;
    this.pausedUntil = Math.max(this.pausedUntil, until);
    this.lastHaltError = error;
  }

  private report(message: string, error: unknown): void {
    // After stop() the database may already be closed; failures then are expected and not reported.
    if (this.stopped) return;
    this.options.logger.error(message, error);
  }
}
