/** Row types for the §12.2 schema. Timestamps are integer milliseconds since the Unix epoch. */

export type MessageDirection = 'in' | 'out' | 'system';
export type OutgoingStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
export type IncomingStatus = 'received' | 'read';
export type MessageStatus = OutgoingStatus | IncomingStatus | 'none';

/** Forward order of statuses (protocol §10): out `failed < pending < sent < delivered < read`; in `received < read`. */
export const OUTGOING_STATUS_RANK: Readonly<Record<OutgoingStatus, number>> = {
  failed: 0,
  pending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
};
export const INCOMING_STATUS_RANK: Readonly<Record<IncomingStatus, number>> = { received: 0, read: 1 };

export function isOutgoingStatus(value: unknown): value is OutgoingStatus {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(OUTGOING_STATUS_RANK, value);
}

export function isIncomingStatus(value: unknown): value is IncomingStatus {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(INCOMING_STATUS_RANK, value);
}

export interface ConversationRow {
  peer_user_id: string;
  peer_username: string;
  peer_avatar_url: string | null;
  last_activity_at: number;
  unread_count: number;
  profile_refreshed_at: number | null;
}

/** Inbox entry: the conversation plus its newest non-system message (preview, arrow, colour; §14). */
export interface InboxRow extends ConversationRow {
  last_message_id: string | null;
  last_direction: 'in' | 'out' | null;
  last_body: string | null;
  last_status: MessageStatus | null;
  last_sort_ts: number | null;
}

export interface MessageRow {
  id: string;
  peer_user_id: string;
  direction: MessageDirection;
  sender_user_id: string | null;
  body: string;
  sent_at: number;
  server_ts: number | null;
  sort_ts: number;
  received_at: number | null;
  status: MessageStatus;
}

export type OutboxKind = 'message' | 'receipt';

export interface ReceiptOutboxPayload {
  peer: string;
  status: 'delivered' | 'read';
  message_ids: string[];
}

export interface OutboxRow {
  id: number;
  kind: OutboxKind;
  message_id: string | null;
  /** JSON text of ReceiptOutboxPayload for kind = 'receipt'. */
  payload: string | null;
  attempts: number;
  next_attempt_at: number;
  created_at: number;
}

/**
 * `delivered` / `read`: a receipt from the peer, applicable to my outgoing rows only.
 * `read_sync`: a read receipt from another device of mine, applicable to incoming rows only.
 * (§12.2 gives receipt_hints no scope column; encoding the scope here keeps §7.2's scoping intact.)
 */
export type ReceiptHintStatus = 'delivered' | 'read' | 'read_sync';

export interface ReceiptHintRow {
  message_id: string;
  status: ReceiptHintStatus;
  at: number;
}

export interface ContactIdentityRow {
  user_id: string;
  /** Base64 Ed25519 AIK public key pinned for this contact. */
  identity_key: string;
  first_seen_at: number;
  verified: 0 | 1;
  pending_identity_key: string | null;
}

export interface HistoryTransferRow {
  transfer_id: string;
  /** Base64 transfer secret; null once the transfer completed. */
  transfer_key: string | null;
  created_at: number;
  last_activity_at: number;
  sender_device_id: string | null;
  attempt_id: string | null;
  total: number | null;
  received_seqs: number[];
  completed_at: number | null;
}
