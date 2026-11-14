import { uuidv4 } from '../../crypto/random';
import { Topics } from '../changes';
import { chunk, placeholders, type RepoContext } from '../context';
import {
  INCOMING_STATUS_RANK,
  isIncomingStatus,
  isOutgoingStatus,
  OUTGOING_STATUS_RANK,
  type IncomingStatus,
  type MessageRow,
  type OutgoingStatus,
} from '../types';

// SQL mirrors of the forward orders in ../types.ts; statuses never move backwards through these.
const OUT_RANK_SQL = `CASE status WHEN 'failed' THEN 0 WHEN 'pending' THEN 1 WHEN 'sent' THEN 2
  WHEN 'delivered' THEN 3 WHEN 'read' THEN 4 ELSE -1 END`;
const IN_RANK_SQL = `CASE status WHEN 'received' THEN 0 WHEN 'read' THEN 1 ELSE -1 END`;

export interface MessageCursor {
  sortTs: number;
  id: string;
}

export type StatusUpdate =
  | { peerUserId: string; direction: 'out'; status: OutgoingStatus; ids: readonly string[] }
  | { peerUserId: string; direction: 'in'; status: IncomingStatus; ids: readonly string[] };

function assertStatusMatchesDirection(row: MessageRow): void {
  const ok =
    (row.direction === 'out' && isOutgoingStatus(row.status)) ||
    (row.direction === 'in' && isIncomingStatus(row.status)) ||
    (row.direction === 'system' && row.status === 'none');
  if (!ok) throw new RangeError(`Status "${String(row.status)}" is not valid for direction "${String(row.direction)}"`);
}

export class MessagesRepository {
  constructor(private readonly ctx: RepoContext) {}

  get(id: string): Promise<MessageRow | null> {
    return this.ctx.sql.getFirstAsync<MessageRow>('SELECT * FROM messages WHERE id = ?', [id]);
  }

  /**
   * Insert-or-ignore on the message id (protocol §13: apply is idempotent). Returns true only when a
   * row was inserted, which is what gates unread counts, conversation summaries and delivered receipts.
   * `ON CONFLICT(id) DO NOTHING` rather than `INSERT OR IGNORE`: the latter would also silently skip
   * rows that violate a CHECK constraint and report them as duplicates.
   */
  async insertOrIgnore(row: MessageRow): Promise<boolean> {
    assertStatusMatchesDirection(row);
    const result = await this.ctx.sql.runAsync(
      `INSERT INTO messages
         (id, peer_user_id, direction, sender_user_id, body, sent_at, server_ts, sort_ts, received_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [
        row.id,
        row.peer_user_id,
        row.direction,
        row.sender_user_id,
        row.body,
        row.sent_at,
        row.server_ts,
        row.sort_ts,
        row.received_at,
        row.status,
      ],
    );
    const inserted = result.changes > 0;
    if (inserted) this.ctx.changed(Topics.messages(row.peer_user_id));
    return inserted;
  }

  /**
   * Local system notice ("… safety code changed", "… could not be decrypted"). Never exported.
   * `serverTs`: the server time of the envelope the notice is about, when there is one.
   */
  async insertSystem(peerUserId: string, body: string, now: number, serverTs: number | null = null): Promise<MessageRow> {
    const row: MessageRow = {
      id: uuidv4(),
      peer_user_id: peerUserId,
      direction: 'system',
      sender_user_id: null,
      body,
      sent_at: now,
      server_ts: serverTs,
      sort_ts: now,
      received_at: now,
      status: 'none',
    };
    await this.insertOrIgnore(row);
    return row;
  }

  /**
   * The conversation's most recently inserted system message whose body ends with `bodySuffix`, with its
   * rowid. Insertion order is SQLite's rowid: `messages` has no INTEGER PRIMARY KEY, so a new row gets a
   * rowid above every row present, and since the app never deletes messages or runs VACUUM (which could
   * renumber them), a committed rowid is never handed out again. Visits every row of the conversation
   * (index on peer_user_id): look it up once, then follow it with `insertedSince`.
   */
  async lastInsertedSystem(peerUserId: string, bodySuffix: string): Promise<{ row: MessageRow; rowid: number } | null> {
    const found = await this.ctx.sql.getFirstAsync<MessageRow & { row_id: number }>(
      `SELECT rowid AS row_id, * FROM messages
       WHERE peer_user_id = ? AND direction = 'system' AND substr(body, -?) = ?
       ORDER BY rowid DESC LIMIT 1`,
      [peerUserId, bodySuffix.length, bodySuffix],
    );
    if (!found) return null;
    const { row_id: rowid, ...row } = found;
    return { row, rowid };
  }

  /**
   * What was inserted into the conversation after rowid `afterRowid`: an incoming message, a system
   * message whose body ends with `bodySuffix`, and the highest rowid now in the table (pass it as
   * `afterRowid` next time). Walks only the rows inserted after `afterRowid`, in rowid order (NOT INDEXED:
   * the peer index would visit the whole conversation instead), so following a row costs what was
   * inserted since, not the size of the history.
   */
  async insertedSince(
    peerUserId: string,
    afterRowid: number,
    bodySuffix: string,
  ): Promise<{ incoming: boolean; system: boolean; top: number }> {
    const found = await this.ctx.sql.getFirstAsync<{ incoming: number; system: number; top: number }>(
      `SELECT
         EXISTS (SELECT 1 FROM messages NOT INDEXED
                 WHERE rowid > ? AND peer_user_id = ? AND direction = 'in') AS incoming,
         EXISTS (SELECT 1 FROM messages NOT INDEXED
                 WHERE rowid > ? AND peer_user_id = ? AND direction = 'system' AND substr(body, -?) = ?) AS system,
         coalesce((SELECT max(rowid) FROM messages), 0) AS top`,
      [afterRowid, peerUserId, afterRowid, peerUserId, bodySuffix.length, bodySuffix],
    );
    return {
      incoming: (found?.incoming ?? 0) !== 0,
      system: (found?.system ?? 0) !== 0,
      top: Math.max(afterRowid, found?.top ?? 0),
    };
  }

  /** The rowid (insertion order) of a message, or null. */
  async rowidOf(id: string): Promise<number | null> {
    const found = await this.ctx.sql.getFirstAsync<{ row_id: number }>('SELECT rowid AS row_id FROM messages WHERE id = ?', [
      id,
    ]);
    return found?.row_id ?? null;
  }

  /** Rewrites a system message in place: same id, same position (sort_ts) in the conversation. */
  async updateSystem(update: { id: string; peerUserId: string; body: string; serverTs: number | null }): Promise<boolean> {
    const result = await this.ctx.sql.runAsync(
      `UPDATE messages SET body = ?, server_ts = ? WHERE id = ? AND peer_user_id = ? AND direction = 'system'`,
      [update.body, update.serverTs, update.id, update.peerUserId],
    );
    if (result.changes > 0) this.ctx.changed(Topics.messages(update.peerUserId));
    return result.changes > 0;
  }

  /**
   * Newest-first page of a conversation. Pass the last row of the previous page as `before` to
   * continue; ties on sort_ts are broken by id so pages never overlap or skip rows.
   */
  listPage(peerUserId: string, options: { before?: MessageCursor; limit: number }): Promise<MessageRow[]> {
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit)));
    if (options.before) {
      const { sortTs, id } = options.before;
      return this.ctx.sql.getAllAsync<MessageRow>(
        `SELECT * FROM messages
         WHERE peer_user_id = ? AND (sort_ts < ? OR (sort_ts = ? AND id < ?))
         ORDER BY sort_ts DESC, id DESC LIMIT ?`,
        [peerUserId, sortTs, sortTs, id, limit],
      );
    }
    return this.ctx.sql.getAllAsync<MessageRow>(
      'SELECT * FROM messages WHERE peer_user_id = ? ORDER BY sort_ts DESC, id DESC LIMIT ?',
      [peerUserId, limit],
    );
  }

  /**
   * Forward-only status change scoped by peer and direction (§7.2: a receipt from user X may only touch
   * X's conversation; read sync only touches incoming rows). Returns the ids that actually changed.
   */
  async updateStatusForward(update: StatusUpdate): Promise<string[]> {
    const rank =
      update.direction === 'out' ? OUTGOING_STATUS_RANK[update.status] : INCOMING_STATUS_RANK[update.status];
    if (rank === undefined) throw new RangeError(`Invalid ${update.direction} status`);
    const rankSql = update.direction === 'out' ? OUT_RANK_SQL : IN_RANK_SQL;
    const changed: string[] = [];
    for (const ids of chunk([...new Set(update.ids)])) {
      const rows = await this.ctx.sql.getAllAsync<{ id: string }>(
        `UPDATE messages SET status = ?
         WHERE peer_user_id = ? AND direction = ? AND id IN (${placeholders(ids)}) AND (${rankSql}) < ?
         RETURNING id`,
        [update.status, update.peerUserId, update.direction, ...ids, rank],
      );
      for (const r of rows) changed.push(r.id);
    }
    // The inbox shows the newest message's status (arrow colour, §14), so the inbox topic changes too.
    if (changed.length > 0) this.ctx.changed(Topics.messages(update.peerUserId), Topics.conversations);
    return changed;
  }

  /** The subset of `ids` that exist as rows (any conversation, any direction). */
  async existingIds(ids: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (const part of chunk([...new Set(ids)])) {
      const rows = await this.ctx.sql.getAllAsync<{ id: string }>(
        `SELECT id FROM messages WHERE id IN (${placeholders(part)})`,
        part,
      );
      for (const r of rows) found.add(r.id);
    }
    return found;
  }

  /**
   * Marks incoming rows the user viewed as read (received → read only). Without `ids`, every unread
   * row of the conversation. Returns changed ids: exactly the ones a `read` receipt may name (§7.2).
   */
  async markIncomingRead(peerUserId: string, ids?: readonly string[]): Promise<string[]> {
    if (ids !== undefined) {
      return ids.length === 0 ? [] : this.updateStatusForward({ peerUserId, direction: 'in', status: 'read', ids });
    }
    const rows = await this.ctx.sql.getAllAsync<{ id: string }>(
      `UPDATE messages SET status = 'read'
       WHERE peer_user_id = ? AND direction = 'in' AND status = 'received' RETURNING id`,
      [peerUserId],
    );
    if (rows.length > 0) this.ctx.changed(Topics.messages(peerUserId), Topics.conversations);
    return rows.map((r) => r.id);
  }

  /** After a successful POST: server timestamp becomes the sort key; status moves forward to `sent`. */
  async markSent(id: string, serverTs: number): Promise<boolean> {
    const rows = await this.ctx.sql.getAllAsync<{ peer_user_id: string }>(
      `UPDATE messages SET server_ts = ?, sort_ts = ?,
         status = CASE WHEN (${OUT_RANK_SQL}) < ${OUTGOING_STATUS_RANK.sent} THEN 'sent' ELSE status END
       WHERE id = ? AND direction = 'out' RETURNING peer_user_id`,
      [serverTs, serverTs, id],
    );
    for (const r of rows) this.ctx.changed(Topics.messages(r.peer_user_id), Topics.conversations);
    return rows.length > 0;
  }

  /** pending → failed (§13 permanent send errors). Never touches rows that already progressed. */
  async markFailed(id: string): Promise<boolean> {
    const rows = await this.ctx.sql.getAllAsync<{ peer_user_id: string }>(
      `UPDATE messages SET status = 'failed' WHERE id = ? AND direction = 'out' AND status = 'pending'
       RETURNING peer_user_id`,
      [id],
    );
    for (const r of rows) this.ctx.changed(Topics.messages(r.peer_user_id), Topics.conversations);
    return rows.length > 0;
  }

  /** failed → pending when the user taps a failed message to retry. */
  async retryFailed(id: string): Promise<boolean> {
    const rows = await this.ctx.sql.getAllAsync<{ peer_user_id: string }>(
      `UPDATE messages SET status = 'pending' WHERE id = ? AND direction = 'out' AND status = 'failed'
       RETURNING peer_user_id`,
      [id],
    );
    for (const r of rows) this.ctx.changed(Topics.messages(r.peer_user_id), Topics.conversations);
    return rows.length > 0;
  }

  /**
   * Moves the conversation's newest system message whose body ends with `bodySuffix` to just before
   * `sortTs`, when it sorts at or after it (the §8 warning must stay above the messages it warns about).
   * Returns whether a row moved.
   */
  async moveSystemBefore(peerUserId: string, bodySuffix: string, sortTs: number): Promise<boolean> {
    const rows = await this.ctx.sql.getAllAsync<{ id: string }>(
      `UPDATE messages SET sort_ts = ?
       WHERE id = (SELECT id FROM messages
                   WHERE peer_user_id = ? AND direction = 'system' AND substr(body, -?) = ?
                   ORDER BY sort_ts DESC, id DESC LIMIT 1)
         AND sort_ts >= ?
       RETURNING id`,
      [sortTs - 1, peerUserId, bodySuffix.length, bodySuffix, sortTs],
    );
    if (rows.length > 0) this.ctx.changed(Topics.messages(peerUserId));
    return rows.length > 0;
  }

  latestNonSystem(peerUserId: string): Promise<MessageRow | null> {
    return this.ctx.sql.getFirstAsync<MessageRow>(
      `SELECT * FROM messages WHERE peer_user_id = ? AND direction != 'system'
       ORDER BY sort_ts DESC, id DESC LIMIT 1`,
      [peerUserId],
    );
  }

  async countUnread(peerUserId: string): Promise<number> {
    const row = await this.ctx.sql.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM messages WHERE peer_user_id = ? AND direction = 'in' AND status = 'received'`,
      [peerUserId],
    );
    return row?.n ?? 0;
  }
}
