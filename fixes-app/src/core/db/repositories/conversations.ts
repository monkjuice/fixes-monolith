import { Topics } from '../changes';
import type { RepoContext } from '../context';
import type { ConversationRow, InboxRow } from '../types';

export class ConversationsRepository {
  constructor(private readonly ctx: RepoContext) {}

  get(peerUserId: string): Promise<ConversationRow | null> {
    return this.ctx.sql.getFirstAsync<ConversationRow>('SELECT * FROM conversations WHERE peer_user_id = ?', [peerUserId]);
  }

  /** Inserts the conversation only when missing (§10 merge rule, §13 placeholder rows). Returns true if inserted. */
  async insertIfMissing(row: {
    peerUserId: string;
    peerUsername: string;
    peerAvatarUrl: string | null;
    lastActivityAt: number;
  }): Promise<boolean> {
    const result = await this.ctx.sql.runAsync(
      `INSERT INTO conversations (peer_user_id, peer_username, peer_avatar_url, last_activity_at)
       VALUES (?, ?, ?, ?) ON CONFLICT(peer_user_id) DO NOTHING`,
      [row.peerUserId, row.peerUsername, row.peerAvatarUrl, row.lastActivityAt],
    );
    if (result.changes > 0) this.ctx.changed(Topics.conversations);
    return result.changes > 0;
  }

  /** Moves last_activity_at forward only (it is the max sort_ts of non-system messages). */
  async bumpActivity(peerUserId: string, sortTs: number): Promise<void> {
    const result = await this.ctx.sql.runAsync(
      'UPDATE conversations SET last_activity_at = ? WHERE peer_user_id = ? AND last_activity_at < ?',
      [sortTs, peerUserId, sortTs],
    );
    if (result.changes > 0) this.ctx.changed(Topics.conversations);
  }

  /**
   * Sets last_activity_at to the max sort_ts of the conversation's non-system messages (it can move
   * back when a pending message's local sort_ts is replaced by the server timestamp). Keeps the
   * current value when the conversation has no such message yet.
   */
  async recomputeActivity(peerUserId: string): Promise<void> {
    const result = await this.ctx.sql.runAsync(
      `UPDATE conversations SET last_activity_at = COALESCE(
         (SELECT MAX(sort_ts) FROM messages WHERE peer_user_id = ? AND direction != 'system'), last_activity_at)
       WHERE peer_user_id = ?`,
      [peerUserId, peerUserId],
    );
    if (result.changes > 0) this.ctx.changed(Topics.conversations);
  }

  async listPeerIds(): Promise<string[]> {
    const rows = await this.ctx.sql.getAllAsync<{ peer_user_id: string }>(
      'SELECT peer_user_id FROM conversations ORDER BY last_activity_at DESC',
    );
    return rows.map((r) => r.peer_user_id);
  }

  async incrementUnread(peerUserId: string, by = 1): Promise<void> {
    const result = await this.ctx.sql.runAsync(
      'UPDATE conversations SET unread_count = unread_count + ? WHERE peer_user_id = ?',
      [by, peerUserId],
    );
    if (result.changes > 0) this.ctx.changed(Topics.conversations);
  }

  /** Recomputes unread_count from incoming rows still in `received` (after read sync or imports). */
  async recountUnread(peerUserId: string): Promise<void> {
    const result = await this.ctx.sql.runAsync(
      `UPDATE conversations SET unread_count = (
         SELECT COUNT(*) FROM messages WHERE peer_user_id = ? AND direction = 'in' AND status = 'received')
       WHERE peer_user_id = ?`,
      [peerUserId, peerUserId],
    );
    if (result.changes > 0) this.ctx.changed(Topics.conversations);
  }

  async updateProfile(peerUserId: string, username: string, avatarUrl: string | null, refreshedAt: number): Promise<void> {
    const result = await this.ctx.sql.runAsync(
      `UPDATE conversations SET peer_username = ?, peer_avatar_url = ?, profile_refreshed_at = ?
       WHERE peer_user_id = ?`,
      [username, avatarUrl, refreshedAt, peerUserId],
    );
    if (result.changes > 0) this.ctx.changed(Topics.conversations);
  }

  /** Inbox rows sorted by last activity, each with its newest non-system message. */
  listInbox(): Promise<InboxRow[]> {
    return this.ctx.sql.getAllAsync<InboxRow>(
      `SELECT c.*, m.id AS last_message_id, m.direction AS last_direction, m.body AS last_body,
              m.status AS last_status, m.sort_ts AS last_sort_ts
       FROM conversations c
       LEFT JOIN messages m ON m.id = (
         SELECT id FROM messages
         WHERE peer_user_id = c.peer_user_id AND direction != 'system'
         ORDER BY sort_ts DESC, id DESC LIMIT 1)
       ORDER BY c.last_activity_at DESC, c.peer_user_id`,
    );
  }

  /** Peers whose name/avatar were never refreshed or not since `olderThan` (§13 inbox refresh). */
  async listPeersToRefresh(olderThan: number, limit = 100): Promise<string[]> {
    const rows = await this.ctx.sql.getAllAsync<{ peer_user_id: string }>(
      `SELECT peer_user_id FROM conversations
       WHERE profile_refreshed_at IS NULL OR profile_refreshed_at < ?
       ORDER BY last_activity_at DESC LIMIT ?`,
      [olderThan, limit],
    );
    return rows.map((r) => r.peer_user_id);
  }
}
