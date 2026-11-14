import { isUuidV4 } from '../crypto/random';
import { arrayField, asObject, isTimestamp, PayloadError, timestampField, uuidField } from './fields';
import type { EnvelopeOrigin, LocalIdentity } from './message';

/** `receipt` payload (protocol §7.2). */

export const MAX_RECEIPT_IDS = 500;

export type ReceiptStatus = 'delivered' | 'read';

export interface ReceiptPayload {
  v: 1;
  kind: 'receipt';
  status: ReceiptStatus;
  /** The other party of the conversation, seen from the user who generated the receipt. */
  peer: string;
  message_ids: string[];
  at: number;
}

export function buildReceiptPayload(params: {
  status: ReceiptStatus;
  peer: string;
  messageIds: readonly string[];
  at: number;
}): ReceiptPayload {
  const ids = [...new Set(params.messageIds)];
  if (params.status !== 'delivered' && params.status !== 'read') throw new PayloadError('Invalid receipt status');
  if (!isUuidV4(params.peer)) throw new PayloadError('Receipt peer must be a UUIDv4');
  if (ids.length < 1 || ids.length > MAX_RECEIPT_IDS || !ids.every(isUuidV4)) {
    throw new PayloadError('A receipt names 1 to 500 message ids');
  }
  if (!isTimestamp(params.at)) throw new PayloadError('Receipt time must be a timestamp');
  return { v: 1, kind: 'receipt', status: params.status, peer: params.peer, message_ids: ids, at: params.at };
}

export function parseReceiptWirePayload(value: unknown): ReceiptPayload {
  const o = asObject(value, 'receipt');
  if (o.v !== 1 || o.kind !== 'receipt') throw new PayloadError('Not a v1 receipt payload');
  if (o.status !== 'delivered' && o.status !== 'read') throw new PayloadError('status must be "delivered" or "read"');
  const ids = arrayField(o, 'message_ids', MAX_RECEIPT_IDS);
  if (ids.length === 0 || !ids.every(isUuidV4)) throw new PayloadError('message_ids must hold 1 to 500 UUIDv4 ids');
  return {
    v: 1,
    kind: 'receipt',
    status: o.status,
    peer: uuidField(o, 'peer'),
    message_ids: [...new Set(ids as string[])],
    at: timestampField(o, 'at'),
  };
}

/**
 * Which rows a receipt may touch (§7.2):
 * - from another user X: only my outgoing rows in the conversation with X;
 * - from another device of mine: read sync of incoming rows in the conversation with `payload.peer`.
 */
export type ReceiptRoute =
  | { kind: 'peer'; peer: string; status: ReceiptStatus }
  | { kind: 'readSync'; peer: string }
  | { kind: 'drop'; reason: string };

export function routeReceipt(payload: ReceiptPayload, origin: EnvelopeOrigin, me: LocalIdentity): ReceiptRoute {
  if (origin.senderUserId !== me.userId) {
    // A receipt from X is about X's conversation with me, so its `peer` (seen from X) must be me.
    if (payload.peer !== me.userId) return { kind: 'drop', reason: 'receipt peer is not this user' };
    return { kind: 'peer', peer: origin.senderUserId, status: payload.status };
  }
  if (origin.senderDeviceId === me.deviceId) return { kind: 'drop', reason: 'receipt from this device' };
  // Own devices only ever send read sync; a "delivered" from myself has no meaning.
  if (payload.status !== 'read') return { kind: 'drop', reason: 'own devices only sync reads' };
  if (payload.peer === me.userId) return { kind: 'drop', reason: 'self-chat is not allowed' };
  return { kind: 'readSync', peer: payload.peer };
}
