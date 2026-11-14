import { ApiError, isSignedOutError, isTransientError } from '../api/errors';
import type { Envelope } from '../api/types';
import { CryptoError } from '../crypto/errors';
import type { LocalStore, Repositories } from '../db/localStore';
import type { MessageRow } from '../db/types';
import type { AppliedTransfer, PreparedTransfer, TransferHandler } from '../linking/types';
import type { Logger } from '../logger';
import { PayloadError } from '../payloads/fields';
import { routeMessage, type EnvelopeOrigin, type LocalIdentity } from '../payloads/message';
import { declaredKind, parsePayload } from '../payloads/parse';
import { routeReceipt, type ReceiptStatus } from '../payloads/receipt';
import type { Clock } from '../platform';
import { IneligibleSenderError, SAFETY_CODE_CHANGED_SUFFIX, type DeviceDirectory, type SenderKey } from '../trust/deviceDirectory';
import { ensureConversation } from './conversationSummary';
import type { EnvelopeCodec } from './envelopeCodec';
import { applyReceiptHints, storeHintsForUnknown } from './receiptHints';
import { queueReceipt } from './receiptQueue';
import { UndecryptableNotices } from './undecryptableNotices';

/**
 * Turns pages of envelopes into local state (protocol §13 "Receive"). Phase 1 resolves sender keys,
 * decrypts and validates each envelope (network allowed, nothing written except trust pins); phase 2
 * applies the whole page in ONE SQLite transaction. Apply is idempotent: message rows are
 * insert-or-ignore, and summaries, unread counts and delivered receipts change only for rows that
 * were actually inserted; undecryptable envelopes are counted once (see UndecryptableNotices).
 */

type Prepared =
  | { type: 'drop'; envelopeId: string; reason: string }
  /** Permanently unreadable envelope from another user: counted in a system message if we know them. */
  | { type: 'undecryptable'; envelopeId: string; peer: string; createdAt: number }
  /** `belowWarning`: from a device certified only by the contact's pending AIK (§8). */
  | { type: 'message'; envelopeId: string; row: MessageRow; belowWarning: boolean }
  | { type: 'receipt'; envelopeId: string; scope: 'peer'; peer: string; status: ReceiptStatus; ids: string[] }
  | { type: 'receipt'; envelopeId: string; scope: 'readSync'; peer: string; ids: string[] }
  | { type: 'transfer'; envelopeId: string; transfer: PreparedTransfer };

export interface ProcessResult {
  /** Envelopes fully handled (applied or deliberately dropped): safe to ack. */
  handledIds: string[];
  /** Placeholder conversations created for unknown peers (fetch their profiles). */
  newPeers: string[];
  /** Receipts were queued in the outbox (kick the worker). */
  queuedReceipts: boolean;
  /** Set when processing stopped early on a transient error; later envelopes stay unacked. */
  stoppedBy: unknown;
}

export interface EnvelopeProcessorOptions {
  store: LocalStore;
  directory: DeviceDirectory;
  codec: EnvelopeCodec;
  self: LocalIdentity;
  transfers: TransferHandler;
  clock: Clock;
  logger: Logger;
  receiptDebounceMs: number;
}

/** Errors that must stop the queue without acking (retried with backoff). */
export function isRetryableReceiveError(error: unknown): boolean {
  return (
    isTransientError(error) || isSignedOutError(error) || (error instanceof ApiError && error.code === 'rate_limited')
  );
}

export class EnvelopeProcessor {
  private readonly notices = new UndecryptableNotices();

  constructor(private readonly options: EnvelopeProcessorOptions) {}

  async process(envelopes: readonly Envelope[]): Promise<ProcessResult> {
    const prepared: Prepared[] = [];
    let stoppedBy: unknown = null;
    for (const envelope of envelopes) {
      try {
        prepared.push(await this.prepare(envelope));
      } catch (error) {
        if (!isRetryableReceiveError(error)) {
          // Not one of the permanent failures of §13 (those are handled in prepare): most likely a local
          // fault such as a storage error. Keep the envelope in the mailbox rather than lose a message.
          this.options.logger.error('Unexpected error while processing an envelope; will retry', error);
        }
        stoppedBy = error;
        break;
      }
    }
    if (prepared.length === 0) return { handledIds: [], newPeers: [], queuedReceipts: false, stoppedBy };
    const effects = await this.options.store.transaction((tx) => this.applyAll(tx, prepared));
    this.notices.commit(effects.counted);
    this.options.transfers.afterCommit(effects.transfers);
    return {
      handledIds: prepared.map((p) => p.envelopeId),
      newPeers: [...effects.newPeers],
      queuedReceipts: effects.queuedReceipts,
      stoppedBy,
    };
  }

  // ---- phase 1 --------------------------------------------------------------------------------

  private async prepare(envelope: Envelope): Promise<Prepared> {
    const { self, directory, codec } = this.options;
    const drop = (reason: string): Prepared => ({ type: 'drop', envelopeId: envelope.id, reason });
    if (envelope.recipient_device_id !== self.deviceId) return drop('not addressed to this device');
    const createdAt = Date.parse(envelope.created_at);
    if (Number.isNaN(createdAt)) return drop('invalid created_at');

    let sender: SenderKey;
    try {
      sender = await directory.resolveSender(envelope.sender_user_id, envelope.sender_device_id, createdAt);
    } catch (error) {
      if (error instanceof IneligibleSenderError) return this.undecryptable(envelope, createdAt, error.message);
      throw error;
    }

    let plaintext: unknown;
    try {
      plaintext = codec.open(envelope, sender.publicKey);
    } catch (error) {
      if (error instanceof CryptoError) return this.undecryptable(envelope, createdAt, error.message);
      throw error;
    }

    let parsed;
    try {
      parsed = parsePayload(plaintext);
    } catch (error) {
      if (!(error instanceof PayloadError)) throw error;
      // An invalid message is reported like an undecryptable one; other kinds are just dropped.
      return declaredKind(plaintext) === 'message'
        ? this.undecryptable(envelope, createdAt, error.message)
        : drop(error.message);
    }

    // §8: an own device certified only by the account key the server reports (not by the AIK this
    // install holds) may deliver the link transfer, which the QR secret authenticates (§7.3), but no
    // sync copies or read syncs: the server could have made its certificate.
    if (sender.viaAccountOnly && (parsed.kind === 'message' || parsed.kind === 'receipt')) {
      return drop("own device not certified by this install's identity key");
    }

    const origin: EnvelopeOrigin = { senderUserId: envelope.sender_user_id, senderDeviceId: envelope.sender_device_id };
    switch (parsed.kind) {
      case 'unknown':
        return drop('unknown payload kind or version');
      case 'message': {
        const route = routeMessage(parsed.payload, origin, self);
        if (route.kind === 'drop') return drop(route.reason);
        const p = parsed.payload;
        const incoming = route.kind === 'incoming';
        const row: MessageRow = {
          id: p.id,
          peer_user_id: route.peer,
          direction: incoming ? 'in' : 'out',
          sender_user_id: p.from,
          body: p.body,
          sent_at: p.sent_at,
          // §7.1: ordering uses the server's envelope time, never the sender clock.
          server_ts: createdAt,
          sort_ts: createdAt,
          received_at: this.options.clock.now(),
          status: incoming ? 'received' : 'sent',
        };
        return { type: 'message', envelopeId: envelope.id, row, belowWarning: incoming && sender.viaPending };
      }
      case 'receipt': {
        const route = routeReceipt(parsed.payload, origin, self);
        if (route.kind === 'drop') return drop(route.reason);
        const ids = parsed.payload.message_ids;
        return route.kind === 'peer'
          ? { type: 'receipt', envelopeId: envelope.id, scope: 'peer', peer: route.peer, status: route.status, ids }
          : { type: 'receipt', envelopeId: envelope.id, scope: 'readSync', peer: route.peer, ids };
      }
      case 'link':
      case 'history': {
        const transfer = await this.options.transfers.prepare(envelope, parsed.payload);
        return transfer ? { type: 'transfer', envelopeId: envelope.id, transfer } : drop('transfer envelope not accepted');
      }
    }
  }

  private undecryptable(envelope: Envelope, createdAt: number, reason: string): Prepared {
    // Own devices have no conversation to warn in; their unreadable envelopes are simply dropped.
    if (envelope.sender_user_id === this.options.self.userId) {
      return { type: 'drop', envelopeId: envelope.id, reason };
    }
    return { type: 'undecryptable', envelopeId: envelope.id, peer: envelope.sender_user_id, createdAt };
  }

  // ---- phase 2 --------------------------------------------------------------------------------

  private async applyAll(tx: Repositories, prepared: readonly Prepared[]) {
    const now = this.options.clock.now();
    const newPeers = new Set<string>();
    const delivered = new Map<string, string[]>();
    const recount = new Set<string>();
    const transfers: AppliedTransfer[] = [];
    const counted = this.notices.begin();

    for (const p of prepared) {
      switch (p.type) {
        case 'drop':
          break;
        case 'undecryptable': {
          // §13: one notice per run of consecutive failures; no unread count, no activity.
          const conversation = await tx.conversations.get(p.peer);
          if (conversation) await this.notices.record(tx, conversation, p, now, counted);
          break;
        }
        case 'message': {
          const { row } = p;
          const peer = row.peer_user_id;
          if (await ensureConversation(tx, peer, row.sort_ts)) newPeers.add(peer);
          if (!(await tx.messages.insertOrIgnore(row))) break;
          // §8: shown below the "safety code changed" warning. The warning carries the local time it was
          // inserted (later than this server time), so it moves up to just before the message instead;
          // the messages keep their server-time order.
          if (p.belowWarning) await tx.messages.moveSystemBefore(peer, SAFETY_CODE_CHANGED_SUFFIX, row.sort_ts);
          await tx.conversations.bumpActivity(peer, row.sort_ts);
          if (row.direction === 'in') {
            await tx.conversations.incrementUnread(peer);
            delivered.set(peer, [...(delivered.get(peer) ?? []), row.id]);
          }
          for (const changedPeer of await applyReceiptHints(tx, [row])) recount.add(changedPeer);
          break;
        }
        case 'receipt':
          if (p.scope === 'peer') {
            await tx.messages.updateStatusForward({ peerUserId: p.peer, direction: 'out', status: p.status, ids: p.ids });
            await storeHintsForUnknown(tx, p.ids, p.status, now);
          } else {
            const changed = await tx.messages.updateStatusForward({
              peerUserId: p.peer,
              direction: 'in',
              status: 'read',
              ids: p.ids,
            });
            if (changed.length > 0) recount.add(p.peer);
            await storeHintsForUnknown(tx, p.ids, 'read_sync', now);
          }
          break;
        case 'transfer': {
          const applied = await this.options.transfers.apply(tx, p.transfer);
          if (applied) {
            transfers.push(applied);
            if (applied.kind === 'history') applied.merge.addedPeers.forEach((peer) => newPeers.add(peer));
          }
          break;
        }
      }
    }

    for (const peer of recount) await tx.conversations.recountUnread(peer);
    // §7.2: delivered receipts only for rows this device actually inserted, coalesced per peer.
    for (const [peer, ids] of delivered) {
      await queueReceipt(tx, { peer, status: 'delivered', ids, now, debounceMs: this.options.receiptDebounceMs });
    }
    return { newPeers, queuedReceipts: delivered.size > 0, transfers, counted };
  }
}
