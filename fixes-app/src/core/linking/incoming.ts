import type { Envelope } from '../api/types';
import { fromBase64Exact, toBase64 } from '../crypto/encoding';
import { CryptoError } from '../crypto/errors';
import type { IdentityKeyPair } from '../crypto/identity';
import { uuidv4 } from '../crypto/random';
import { generateTransferKey, openTransfer, type TransferPayload } from '../crypto/transfer';
import type { LocalStore, Repositories } from '../db/localStore';
import type { HistoryTransferRow } from '../db/types';
import type { Logger } from '../logger';
import { PayloadError } from '../payloads/fields';
import { parseLinkInner } from '../payloads/link';
import { parseSnapshotBody } from '../payloads/snapshot';
import type { Clock } from '../platform';
import { addMergeResults, emptyMergeResult, mergeSnapshot, type MergeResult } from '../snapshot/merge';
import { StateCell } from '../utils/stateCell';
import { formatLinkQr } from './qr';
import type { AppliedTransfer, PreparedTransfer, TransferHandler } from './types';

/**
 * The new device's side of linking (protocol §9 steps 2 and 5): shows the QR, receives the `link`
 * envelope (the AIK secret) and the `history` chunks, enforces the attempt binding and the expiry
 * rules, and deletes the transfer key on completion.
 */

export type IncomingTransferPhase = 'idle' | 'waiting' | 'receiving' | 'complete' | 'expired';

export interface IncomingTransferState {
  phase: IncomingTransferPhase;
  transferId: string | null;
  /** The QR text to display while waiting/receiving. */
  qr: string | null;
  linkReceived: boolean;
  receivedChunks: number;
  totalChunks: number | null;
  imported: MergeResult;
}

export const IDLE_INCOMING_TRANSFER: IncomingTransferState = {
  phase: 'idle',
  transferId: null,
  qr: null,
  linkReceived: false,
  receivedChunks: 0,
  totalChunks: null,
  imported: emptyMergeResult(),
};

/** How the transferred AIK reaches the session (secure storage, link state). */
export interface IdentitySink {
  /** Base64 AIK the server reports for this account (`users.identity_key`). */
  accountIdentityKey(): string | null;
  /** Persists the AIK secret (`fixes.identity.<user_id>`). */
  storeIdentity(identity: IdentityKeyPair): Promise<void>;
  /** Called after the link was applied; must not block (it re-checks the session's link state). */
  identityStored(): void;
}

export interface IncomingTransfersOptions {
  store: LocalStore;
  clock: Clock;
  logger: Logger;
  self: { userId: string; deviceId: string; publicKey: Uint8Array };
  identity: IdentitySink;
  /** §9: 30 min to the first chunk, then 10 min of inactivity. */
  firstChunkTimeoutMs: number;
  inactivityTimeoutMs: number;
  /** Called with peers whose conversations a completed transfer created (names/avatars refresh). */
  onCompleted?(addedPeers: string[]): void;
}

export class IncomingTransfers implements TransferHandler {
  readonly state = new StateCell<IncomingTransferState>(IDLE_INCOMING_TRANSFER);

  constructor(private readonly options: IncomingTransfersOptions) {}

  /**
   * The QR for the open transfer, creating one when none is open (the same code stays valid until the
   * transfer completes or expires, so "Resend" on the other device can reuse it).
   */
  async createQr(): Promise<string> {
    const { store, clock } = this.options;
    await this.expireStale();
    const open = (await store.historyTransfers.listOpen()).filter((row) => row.transfer_key !== null);
    const current = open[open.length - 1];
    if (current) {
      const qr = this.qrFor(current.transfer_id, fromBase64Exact(current.transfer_key!, 32));
      this.showOpen(current, qr);
      return qr;
    }
    const transferId = uuidv4();
    const key = generateTransferKey();
    await store.historyTransfers.create(transferId, toBase64(key), clock.now());
    const qr = this.qrFor(transferId, key);
    this.state.set({ ...IDLE_INCOMING_TRANSFER, phase: 'waiting', transferId, qr });
    return qr;
  }

  /** Abandons open transfers (the user left the screen or wants a fresh code). */
  async cancel(): Promise<void> {
    for (const row of await this.options.store.historyTransfers.listOpen()) {
      await this.options.store.historyTransfers.delete(row.transfer_id);
    }
    this.state.set(IDLE_INCOMING_TRANSFER);
  }

  /** Applies the expiry rules to open transfers (called periodically and before using one). */
  async expireStale(): Promise<void> {
    const { store, clock } = this.options;
    const now = clock.now();
    for (const row of await store.historyTransfers.listOpen()) {
      if (this.isExpired(row, now)) {
        // Deleting the row deletes the transfer key: nothing sealed with it is accepted any more.
        await store.historyTransfers.delete(row.transfer_id);
        if (this.state.get().transferId === row.transfer_id) this.state.update({ phase: 'expired', qr: null });
      }
    }
  }

  // ---- TransferHandler (called by the receive queue) -----------------------------------------

  async prepare(envelope: Envelope, payload: TransferPayload): Promise<PreparedTransfer | null> {
    const { self, store, clock, logger, identity } = this.options;
    // §7.3: only from another device of this account.
    if (envelope.sender_user_id !== self.userId || envelope.sender_device_id === self.deviceId) return null;
    const row = await store.historyTransfers.get(payload.transfer_id);
    if (!row || row.completed_at !== null || row.transfer_key === null) return null;
    if (this.isExpired(row, clock.now())) {
      await this.expireStale();
      return null;
    }
    // §9 step 5: the transfer is bound to the first sender device; chunks from others are ignored.
    if (row.sender_device_id !== null && row.sender_device_id !== envelope.sender_device_id) return null;
    let inner: unknown;
    try {
      inner = openTransfer(payload, fromBase64Exact(row.transfer_key, 32)).inner;
    } catch (error) {
      if (error instanceof CryptoError) return null;
      throw error;
    }
    const base = { transferId: payload.transfer_id, senderDeviceId: envelope.sender_device_id, attemptId: payload.attempt_id };
    if (payload.kind === 'link') {
      if (payload.seq !== 0 || payload.total !== 1) return null;
      let aik: IdentityKeyPair;
      try {
        aik = parseLinkInner(inner);
      } catch (error) {
        if (error instanceof PayloadError) return null;
        throw error;
      }
      // §7.3: the public half must be the server's users.identity_key (the secret was checked above).
      if (identity.accountIdentityKey() !== toBase64(aik.publicKey)) {
        logger.warn('A link transfer carried an identity key that is not the account key; ignored');
        return null;
      }
      // Stored before the envelope is acked; a storage failure leaves it in the mailbox for a retry.
      await identity.storeIdentity(aik);
      return { kind: 'link', ...base };
    }
    try {
      return { kind: 'history', ...base, seq: payload.seq, total: payload.total, body: parseSnapshotBody(inner, self.userId) };
    } catch (error) {
      if (error instanceof PayloadError) return null;
      throw error;
    }
  }

  async apply(tx: Repositories, prepared: PreparedTransfer): Promise<AppliedTransfer | null> {
    const now = this.options.clock.now();
    const row = await tx.historyTransfers.get(prepared.transferId);
    if (!row || row.completed_at !== null || row.transfer_key === null) return null;
    if (row.sender_device_id !== null && row.sender_device_id !== prepared.senderDeviceId) return null;
    const newAttempt = row.sender_device_id === null || row.attempt_id !== prepared.attemptId;

    if (prepared.kind === 'link') {
      if (newAttempt) await tx.historyTransfers.bindAttempt(row.transfer_id, prepared.senderDeviceId, prepared.attemptId, null, now);
      else await tx.historyTransfers.touch(row.transfer_id, now);
      return { kind: 'link', transferId: row.transfer_id };
    }

    if (newAttempt || row.total === null) {
      // A new attempt from the bound device resets total/received_seqs; imported rows stay (§9 step 5).
      await tx.historyTransfers.bindAttempt(row.transfer_id, prepared.senderDeviceId, prepared.attemptId, prepared.total, now);
    } else if (row.total !== prepared.total) {
      return null;
    }
    const merge = await mergeSnapshot(tx, prepared.body, { me: this.options.self.userId, source: 'history', now });
    const updated = await tx.historyTransfers.recordSeq(row.transfer_id, prepared.seq, now);
    if (!updated) return null;
    const complete = updated.received_seqs.length === prepared.total;
    // §9 step 5: complete once seqs 0..total-1 of one attempt arrived; the transfer key is deleted.
    if (complete) await tx.historyTransfers.complete(row.transfer_id, now);
    return {
      kind: 'history',
      transferId: row.transfer_id,
      merge,
      received: updated.received_seqs.length,
      total: prepared.total,
      complete,
    };
  }

  afterCommit(applied: readonly AppliedTransfer[]): void {
    for (const result of applied) {
      const current = this.state.get();
      const tracked = current.transferId === result.transferId;
      const base: IncomingTransferState = tracked
        ? current
        : { ...IDLE_INCOMING_TRANSFER, transferId: result.transferId, phase: 'receiving' };
      if (result.kind === 'link') {
        this.state.set({ ...base, phase: base.phase === 'complete' ? 'complete' : 'receiving', linkReceived: true });
        this.options.identity.identityStored();
        continue;
      }
      const imported = addMergeResults(base.imported, result.merge);
      this.state.set({
        ...base,
        phase: result.complete ? 'complete' : 'receiving',
        qr: result.complete ? null : base.qr,
        receivedChunks: result.received,
        totalChunks: result.total,
        imported,
      });
      if (result.complete) this.options.onCompleted?.(imported.addedPeers);
    }
  }

  // ---- internals ------------------------------------------------------------------------------

  private isExpired(row: HistoryTransferRow, now: number): boolean {
    if (row.completed_at !== null) return false;
    return row.sender_device_id === null
      ? now - row.created_at > this.options.firstChunkTimeoutMs
      : now - row.last_activity_at > this.options.inactivityTimeoutMs;
  }

  private qrFor(transferId: string, transferKey: Uint8Array): string {
    const { self } = this.options;
    return formatLinkQr({ transferId, deviceId: self.deviceId, devicePublicKey: self.publicKey, transferKey });
  }

  private showOpen(row: HistoryTransferRow, qr: string): void {
    const current = this.state.get();
    if (current.transferId === row.transfer_id) {
      this.state.update({ qr });
      return;
    }
    this.state.set({
      ...IDLE_INCOMING_TRANSFER,
      phase: row.sender_device_id === null ? 'waiting' : 'receiving',
      transferId: row.transfer_id,
      qr,
      receivedChunks: row.received_seqs.length,
      totalChunks: row.total,
    });
  }
}
