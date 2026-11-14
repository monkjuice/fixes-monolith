import type { Repositories } from '../db/localStore';
import type { MessageRow, MessageStatus } from '../db/types';
import { ensureConversation } from '../messaging/conversationSummary';
import { applyReceiptHints, type HintTarget } from '../messaging/receiptHints';
import type { MsgRecord, ParsedSnapshot } from '../payloads/snapshot';

/** Counts reported after a backup import or a history chunk (§10). */
export interface MergeResult {
  conversationsAdded: number;
  messagesAdded: number;
  messagesUpdated: number;
  contactsAdded: number;
  /** Invalid or inconsistent rows that were skipped. */
  skipped: number;
  /** Contacts whose imported key differs from the pin on this device (the pin wins; tell the user). */
  identityConflicts: string[];
  /** Conversations created by the import; their names/avatars should be refreshed from the server. */
  addedPeers: string[];
}

export interface MergeOptions {
  me: string;
  /** Backups mark incoming rows read; history transfers keep their status (§10). */
  source: 'backup' | 'history';
  now: number;
}

export function emptyMergeResult(): MergeResult {
  return {
    conversationsAdded: 0,
    messagesAdded: 0,
    messagesUpdated: 0,
    contactsAdded: 0,
    skipped: 0,
    identityConflicts: [],
    addedPeers: [],
  };
}

/** Imported pending rows become failed (never auto-sent); backup incoming rows become read. */
function importedStatus(message: MsgRecord, source: MergeOptions['source']): MessageStatus {
  if (message.direction === 'out') return message.status === 'pending' ? 'failed' : message.status;
  return source === 'backup' ? 'read' : message.status;
}

/**
 * The merge rules of §10 (backup import and history transfer), inside the caller's transaction:
 * messages insert-or-ignore keeping the highest status, conversations only when missing, an existing
 * contact pin always wins, receipt hints applied afterwards. Idempotent.
 */
export async function mergeSnapshot(tx: Repositories, snapshot: ParsedSnapshot, options: MergeOptions): Promise<MergeResult> {
  const result = emptyMergeResult();
  result.skipped = snapshot.skipped;
  const added = new Set<string>();
  const touched = new Set<string>();

  for (const conv of snapshot.conversations) {
    const inserted = await tx.conversations.insertIfMissing({
      peerUserId: conv.peer_user_id,
      peerUsername: conv.peer_username,
      peerAvatarUrl: conv.peer_avatar_url,
      lastActivityAt: 0,
    });
    if (inserted) {
      added.add(conv.peer_user_id);
      result.conversationsAdded++;
    }
  }

  const inserted: HintTarget[] = [];
  for (const message of snapshot.messages) {
    const status = importedStatus(message, options.source);
    const existing = await tx.messages.get(message.id);
    if (!existing) {
      if (await ensureConversation(tx, message.peer_user_id, 0)) {
        added.add(message.peer_user_id);
        result.conversationsAdded++;
      }
      const row: MessageRow = {
        id: message.id,
        peer_user_id: message.peer_user_id,
        direction: message.direction,
        sender_user_id: message.sender_user_id,
        body: message.body,
        sent_at: message.sent_at,
        server_ts: message.server_ts,
        sort_ts: message.server_ts ?? message.sent_at,
        received_at: options.now,
        status,
      };
      if (await tx.messages.insertOrIgnore(row)) {
        result.messagesAdded++;
        inserted.push(row);
        touched.add(row.peer_user_id);
      }
      continue;
    }
    if (existing.direction !== message.direction || existing.peer_user_id !== message.peer_user_id) {
      // Same id, different conversation or direction: never let an import rewrite another row.
      result.skipped++;
      continue;
    }
    const changed =
      message.direction === 'out'
        ? await tx.messages.updateStatusForward({
            peerUserId: message.peer_user_id,
            direction: 'out',
            status: status as typeof message.status,
            ids: [message.id],
          })
        : await tx.messages.updateStatusForward({
            peerUserId: message.peer_user_id,
            direction: 'in',
            status: status as typeof message.status,
            ids: [message.id],
          });
    if (changed.length > 0) {
      result.messagesUpdated++;
      touched.add(message.peer_user_id);
    }
  }

  for (const ident of snapshot.contact_identities) {
    if (ident.user_id === options.me) continue;
    const existing = await tx.contactIdentities.get(ident.user_id);
    if (!existing) {
      if (await tx.contactIdentities.pinIfAbsent(ident.user_id, ident.identity_key, ident.first_seen_at, ident.verified)) {
        result.contactsAdded++;
      }
    } else if (existing.identity_key !== ident.identity_key) {
      result.identityConflicts.push(ident.user_id);
    }
  }

  for (const peer of await applyReceiptHints(tx, inserted)) touched.add(peer);
  for (const peer of new Set([...touched, ...added])) {
    await tx.conversations.recomputeActivity(peer);
    await tx.conversations.recountUnread(peer);
  }
  result.addedPeers = [...added];
  return result;
}

/** Adds the counts of `next` to `total` (history arrives in several chunks). */
export function addMergeResults(total: MergeResult, next: MergeResult): MergeResult {
  return {
    conversationsAdded: total.conversationsAdded + next.conversationsAdded,
    messagesAdded: total.messagesAdded + next.messagesAdded,
    messagesUpdated: total.messagesUpdated + next.messagesUpdated,
    contactsAdded: total.contactsAdded + next.contactsAdded,
    skipped: total.skipped + next.skipped,
    identityConflicts: [...new Set([...total.identityConflicts, ...next.identityConflicts])],
    addedPeers: [...new Set([...total.addedPeers, ...next.addedPeers])],
  };
}
