import type { Envelope } from '../api/types';
import type { TransferPayload } from '../crypto/transfer';
import type { Repositories } from '../db/localStore';
import type { ParsedSnapshot } from '../payloads/snapshot';
import type { MergeResult } from '../snapshot/merge';

/** A `link`/`history` envelope that opened and validated (phase 1, before the page transaction). */
export type PreparedTransfer =
  | { kind: 'link'; transferId: string; senderDeviceId: string; attemptId: string }
  | {
      kind: 'history';
      transferId: string;
      senderDeviceId: string;
      attemptId: string;
      seq: number;
      total: number;
      body: ParsedSnapshot;
    };

/** What applying it changed (phase 2, inside the page transaction). */
export type AppliedTransfer =
  | { kind: 'link'; transferId: string }
  | { kind: 'history'; transferId: string; merge: MergeResult; received: number; total: number; complete: boolean };

/** The receive queue hands `link`/`history` payloads to the new-device side of linking (§9 step 5). */
export interface TransferHandler {
  /** Null means "drop": not ours, unknown/expired transfer, other sender device, or a box that does not open. */
  prepare(envelope: Envelope, payload: TransferPayload): Promise<PreparedTransfer | null>;
  apply(tx: Repositories, prepared: PreparedTransfer): Promise<AppliedTransfer | null>;
  /** Called after the transaction committed. */
  afterCommit(applied: readonly AppliedTransfer[]): void;
}
