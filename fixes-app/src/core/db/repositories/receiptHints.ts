import { Topics } from '../changes';
import { chunk, placeholders, type RepoContext } from '../context';
import type { ReceiptHintRow, ReceiptHintStatus } from '../types';

// `read_sync` (from my own devices, applies to incoming rows only) outranks the peer statuses: a
// legitimate own-device hint must never be displaced by a peer's receipt naming the same id.
const HINT_RANK_SQL = (column: string) =>
  `CASE ${column} WHEN 'delivered' THEN 1 WHEN 'read' THEN 2 WHEN 'read_sync' THEN 3 ELSE 0 END`;

/**
 * Receipts for messages not stored yet (§7.2); applied when the row appears, pruned after 30 days.
 * The status column also records the receipt's scope (see ReceiptHintStatus), so a hint can only
 * touch the rows its receipt was allowed to touch.
 */
export class ReceiptHintsRepository {
  constructor(private readonly ctx: RepoContext) {}

  /** Stores a hint, keeping the most advanced status when one already exists. */
  async put(messageId: string, status: ReceiptHintStatus, at: number): Promise<void> {
    await this.ctx.sql.runAsync(
      `INSERT INTO receipt_hints (message_id, status, at) VALUES (?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET status = excluded.status, at = excluded.at
       WHERE ${HINT_RANK_SQL('excluded.status')} > ${HINT_RANK_SQL('receipt_hints.status')}`,
      [messageId, status, at],
    );
    this.ctx.changed(Topics.receiptHints);
  }

  /** Removes and returns the hints for these ids (the caller applies them with the forward-only rules). */
  async take(messageIds: readonly string[]): Promise<ReceiptHintRow[]> {
    const out: ReceiptHintRow[] = [];
    for (const ids of chunk([...new Set(messageIds)])) {
      const rows = await this.ctx.sql.getAllAsync<ReceiptHintRow>(
        `DELETE FROM receipt_hints WHERE message_id IN (${placeholders(ids)}) RETURNING message_id, status, at`,
        ids,
      );
      out.push(...rows);
    }
    if (out.length > 0) this.ctx.changed(Topics.receiptHints);
    return out;
  }

  async pruneOlderThan(cutoff: number): Promise<number> {
    const result = await this.ctx.sql.runAsync('DELETE FROM receipt_hints WHERE at < ?', [cutoff]);
    if (result.changes > 0) this.ctx.changed(Topics.receiptHints);
    return result.changes;
  }

  listAll(): Promise<ReceiptHintRow[]> {
    return this.ctx.sql.getAllAsync<ReceiptHintRow>('SELECT * FROM receipt_hints ORDER BY message_id');
  }
}
