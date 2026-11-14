import { utf8Encode } from '../crypto/encoding';
import { MAX_TRANSFER_INNER_BYTES } from '../crypto/transfer';
import type { LocalStore } from '../db/localStore';
import {
  isIncomingStatus,
  isOutgoingStatus,
  type ContactIdentityRow,
  type ConversationRow,
  type MessageRow,
} from '../db/types';
import type { ConvRecord, IdentRecord, MsgRecord, SnapshotBody } from '../payloads/snapshot';

/**
 * Reads everything a history transfer or a backup carries (protocol §7.3, §10) in one read
 * transaction, so the snapshot is consistent even while the receive queue keeps writing.
 * System messages are never exported; this device's outbox and receipt hints are not either.
 */
export async function readSnapshot(store: LocalStore): Promise<SnapshotBody> {
  return store.transaction(async (tx) => {
    const conversations = await tx.sql.getAllAsync<ConversationRow>(
      'SELECT * FROM conversations ORDER BY last_activity_at DESC, peer_user_id',
    );
    const messages = await tx.sql.getAllAsync<MessageRow>(
      `SELECT * FROM messages WHERE direction != 'system' ORDER BY sort_ts, id`,
    );
    const identities: ContactIdentityRow[] = await tx.contactIdentities.list();
    return {
      conversations: conversations.map(toConvRecord),
      messages: messages.map(toMsgRecord).filter((m): m is MsgRecord => m !== null),
      contact_identities: identities.map(toIdentRecord),
    };
  });
}

function toConvRecord(row: ConversationRow): ConvRecord {
  return { peer_user_id: row.peer_user_id, peer_username: row.peer_username, peer_avatar_url: row.peer_avatar_url };
}

function toMsgRecord(row: MessageRow): MsgRecord | null {
  const common = {
    id: row.id,
    peer_user_id: row.peer_user_id,
    sender_user_id: row.sender_user_id ?? '',
    body: row.body,
    sent_at: row.sent_at,
    server_ts: row.server_ts,
  };
  if (row.direction === 'out' && isOutgoingStatus(row.status)) return { ...common, direction: 'out', status: row.status };
  if (row.direction === 'in' && isIncomingStatus(row.status)) return { ...common, direction: 'in', status: row.status };
  // The repositories never write such rows; skipping keeps one bad row from blocking an export.
  return null;
}

function toIdentRecord(row: ContactIdentityRow): IdentRecord {
  return {
    user_id: row.user_id,
    identity_key: row.identity_key,
    first_seen_at: row.first_seen_at,
    verified: row.verified === 1,
  };
}

const EMPTY_SIZE = utf8Encode(JSON.stringify({ conversations: [], messages: [], contact_identities: [] })).length;

type Section = keyof SnapshotBody;

/**
 * Splits a snapshot into history chunks whose inner JSON is at most `maxBytes` UTF-8 bytes (§7.3).
 * Conversations and identities come first so later message chunks land in named conversations.
 * Always returns at least one chunk (§9 step 6: an empty history is still one chunk).
 */
export function chunkSnapshot(body: SnapshotBody, maxBytes: number = MAX_TRANSFER_INNER_BYTES): SnapshotBody[] {
  const chunks: SnapshotBody[] = [];
  let current: SnapshotBody = { conversations: [], messages: [], contact_identities: [] };
  let size = EMPTY_SIZE;
  const add = (section: Section, item: unknown) => {
    const itemSize = utf8Encode(JSON.stringify(item)).length;
    if (EMPTY_SIZE + itemSize > maxBytes) throw new RangeError(`A ${section} record does not fit in one chunk`);
    const separator = current[section].length > 0 ? 1 : 0;
    if (size + separator + itemSize > maxBytes) {
      chunks.push(current);
      current = { conversations: [], messages: [], contact_identities: [] };
      size = EMPTY_SIZE;
      add(section, item);
      return;
    }
    (current[section] as unknown[]).push(item);
    size += separator + itemSize;
  };
  for (const conv of body.conversations) add('conversations', conv);
  for (const ident of body.contact_identities) add('contact_identities', ident);
  for (const message of body.messages) add('messages', message);
  chunks.push(current);
  return chunks;
}
