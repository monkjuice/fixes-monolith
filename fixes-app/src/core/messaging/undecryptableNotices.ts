import type { Repositories } from '../db/localStore';
import type { ConversationRow, MessageRow } from '../db/types';
import { BoundedSet } from '../utils/boundedSet';
import { UNDECRYPTABLE_SUFFIX, undecryptableCount, undecryptableText } from './conversationSummary';

/** A permanently unreadable envelope from another user (§13). */
export interface UndecryptableEnvelope {
  envelopeId: string;
  /** The envelope's server time (`created_at`). */
  createdAt: number;
}

/**
 * Where a contact's newest notice is, and what is known about the rows inserted after it: the rows with
 * rowid in (`rowid`, `scannedTo`] were checked; none is a newer notice for the contact, and
 * `incomingAfter` says whether one is a message from the contact (which ends the run).
 */
interface NoticeCursor {
  id: string;
  rowid: number;
  scannedTo: number;
  incomingAfter: boolean;
}

/** What one apply transaction counted; `commit` keeps it once that transaction committed. */
export interface CountedFailures {
  readonly envelopeIds: Set<string>;
  readonly noticeIds: Set<string>;
  /** Cursors moved in this transaction, by peer user id. */
  readonly cursors: Map<string, NoticeCursor>;
}

// Like the receive queue's memory of applied envelopes: a duplicate can only be a recent envelope.
const SESSION_MEMORY = 10_000;

/**
 * Protocol §13 notices for undecryptable messages from a known contact: consecutive failures from one
 * contact collapse into one notice that counts them, and a new notice starts only after a message from
 * that contact was stored. The run lives in the database, so it survives restarts:
 * - the open notice is the contact's most recently inserted "… could not be decrypted" notice, as long
 *   as no incoming message was inserted after it (that message ends the run);
 * - its body holds the count, its `server_ts` the `created_at` of the newest envelope counted;
 * - it keeps the id and sort_ts of its first failure (its place in the conversation) and, like every
 *   system message, never changes `unread_count` or `last_activity_at`.
 *
 * Cost: finding the newest notice visits the whole conversation, so it is done once per contact and
 * session; after that a cursor follows it and each failure checks only the rows inserted since the
 * previous one. A flood therefore costs the same in a long conversation as in an empty one. The cursor
 * is only an accelerator: it re-reads the notice and falls back to the full lookup when the notice is
 * gone or another writer inserted a newer one, and it moves only when its transaction commits (a
 * rolled-back transaction's rowids are handed out again).
 *
 * Each envelope counts once. This instance remembers the envelopes it counted (exact within a session).
 * A notice it has not changed was last changed before this session (app restart, new runtime): an
 * envelope no newer than that notice's `server_ts` is then taken as the redelivery of a page that was
 * applied but not acked. That test is not exact (§12.2 has no column for the envelope id, the mailbox's
 * own order); see the README's limits for when it undercounts or counts twice.
 */
export class UndecryptableNotices {
  private readonly countedEnvelopes = new BoundedSet(SESSION_MEMORY);
  private readonly changedNotices = new BoundedSet(SESSION_MEMORY);
  // One entry per contact with a conversation that sent an undecryptable envelope this session.
  private readonly cursors = new Map<string, NoticeCursor>();

  /** Bookkeeping for one apply transaction. */
  begin(): CountedFailures {
    return { envelopeIds: new Set(), noticeIds: new Set(), cursors: new Map() };
  }

  /** Counts a failure from the peer of `conversation`; call inside the apply transaction. */
  async record(
    tx: Repositories,
    conversation: ConversationRow,
    failure: UndecryptableEnvelope,
    now: number,
    counted: CountedFailures,
  ): Promise<void> {
    const { envelopeId, createdAt } = failure;
    if (this.countedEnvelopes.has(envelopeId) || counted.envelopeIds.has(envelopeId)) return;
    const peerUserId = conversation.peer_user_id;
    const last = await this.lastNotice(tx, peerUserId, counted);
    if (last) counted.cursors.set(peerUserId, last.cursor);
    const lastServerTs = last?.row.server_ts ?? null;
    if (last && lastServerTs !== null && createdAt <= lastServerTs) {
      const changedThisSession = this.changedNotices.has(last.row.id) || counted.noticeIds.has(last.row.id);
      if (!changedThisSession) return;
    }

    let noticeId: string;
    if (last && !last.cursor.incomingAfter) {
      const count = (undecryptableCount(last.row.body) ?? 1) + 1;
      await tx.messages.updateSystem({
        id: last.row.id,
        peerUserId,
        body: undecryptableText(conversation.peer_username, count),
        serverTs: Math.max(lastServerTs ?? createdAt, createdAt),
      });
      noticeId = last.row.id;
    } else {
      const text = undecryptableText(conversation.peer_username);
      noticeId = (await tx.messages.insertSystem(peerUserId, text, now, createdAt)).id;
      const rowid = await tx.messages.rowidOf(noticeId);
      if (rowid === null) throw new Error('Inserted notice not found');
      counted.cursors.set(peerUserId, { id: noticeId, rowid, scannedTo: rowid, incomingAfter: false });
    }
    counted.envelopeIds.add(envelopeId);
    counted.noticeIds.add(noticeId);
  }

  /** Remembers what a committed transaction counted (a rolled-back one counted nothing). */
  commit(counted: CountedFailures): void {
    for (const id of counted.envelopeIds) this.countedEnvelopes.add(id);
    for (const id of counted.noticeIds) this.changedNotices.add(id);
    for (const [peer, cursor] of counted.cursors) this.cursors.set(peer, cursor);
  }

  /** The contact's newest notice and whether a message from them was inserted after it. */
  private async lastNotice(
    tx: Repositories,
    peerUserId: string,
    counted: CountedFailures,
  ): Promise<{ row: MessageRow; cursor: NoticeCursor } | null> {
    const cached = counted.cursors.get(peerUserId) ?? this.cursors.get(peerUserId);
    if (cached) {
      const row = await tx.messages.get(cached.id);
      if (row && row.peer_user_id === peerUserId && row.direction === 'system') {
        const since = await tx.messages.insertedSince(peerUserId, cached.scannedTo, UNDECRYPTABLE_SUFFIX);
        if (!since.system) {
          const incomingAfter = cached.incomingAfter || since.incoming;
          return { row, cursor: { ...cached, scannedTo: since.top, incomingAfter } };
        }
      }
    }
    const found = await tx.messages.lastInsertedSystem(peerUserId, UNDECRYPTABLE_SUFFIX);
    if (!found) return null;
    const since = await tx.messages.insertedSince(peerUserId, found.rowid, UNDECRYPTABLE_SUFFIX);
    return {
      row: found.row,
      cursor: { id: found.row.id, rowid: found.rowid, scannedTo: since.top, incomingAfter: since.incoming },
    };
  }
}
