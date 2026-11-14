import { Topics } from '../changes';
import type { RepoContext } from '../context';
import type { OutboxRow, ReceiptOutboxPayload } from '../types';

/** This device's pending network work (§12.2: never exported). */
export class OutboxRepository {
  constructor(private readonly ctx: RepoContext) {}

  async enqueueMessage(messageId: string, now: number): Promise<number> {
    const result = await this.ctx.sql.runAsync(
      `INSERT INTO outbox (kind, message_id, payload, next_attempt_at, created_at) VALUES ('message', ?, NULL, ?, ?)`,
      [messageId, now, now],
    );
    this.ctx.changed(Topics.outbox);
    return result.lastInsertRowId;
  }

  /** `nextAttemptAt` later than `now` is the coalescing window of §7.2 (receipts are debounced). */
  async enqueueReceipt(payload: ReceiptOutboxPayload, now: number, nextAttemptAt: number = now): Promise<number> {
    const result = await this.ctx.sql.runAsync(
      `INSERT INTO outbox (kind, message_id, payload, next_attempt_at, created_at) VALUES ('receipt', NULL, ?, ?, ?)`,
      [JSON.stringify(payload), nextAttemptAt, now],
    );
    this.ctx.changed(Topics.outbox);
    return result.lastInsertRowId;
  }

  /**
   * Receipt rows still inside their coalescing window: never attempted and not due yet, so the worker
   * cannot be sending them (it claims a row before sending it, see claimReceipt). Newest first.
   */
  listReceiptsAwaitingDebounce(now: number): Promise<OutboxRow[]> {
    return this.ctx.sql.getAllAsync<OutboxRow>(
      `SELECT * FROM outbox WHERE kind = 'receipt' AND attempts = 0 AND next_attempt_at > ? ORDER BY id DESC`,
      [now],
    );
  }

  /**
   * Marks a receipt row as attempted before it is sent, which takes it out of its coalescing window
   * (listReceiptsAwaitingDebounce no longer returns it), and returns it as it is now; null when gone.
   */
  async claimReceipt(id: number): Promise<OutboxRow | null> {
    const rows = await this.ctx.sql.getAllAsync<OutboxRow>(
      `UPDATE outbox SET attempts = MAX(attempts, 1) WHERE id = ? AND kind = 'receipt' RETURNING *`,
      [id],
    );
    if (rows.length > 0) this.ctx.changed(Topics.outbox);
    return rows[0] ?? null;
  }

  async updateReceiptPayload(id: number, payload: ReceiptOutboxPayload): Promise<void> {
    await this.ctx.sql.runAsync(`UPDATE outbox SET payload = ? WHERE id = ? AND kind = 'receipt'`, [
      JSON.stringify(payload),
      id,
    ]);
    this.ctx.changed(Topics.outbox);
  }

  /**
   * Makes scheduled rows due now (connectivity is back, or the user acted). With `retriesOnly`, rows
   * still inside a receipt coalescing window (never attempted) keep their schedule.
   */
  async makeDue(now: number, options: { retriesOnly?: boolean } = {}): Promise<void> {
    const result = await this.ctx.sql.runAsync(
      `UPDATE outbox SET next_attempt_at = ? WHERE next_attempt_at > ?${options.retriesOnly ? ' AND attempts > 0' : ''}`,
      [now, now],
    );
    if (result.changes > 0) this.ctx.changed(Topics.outbox);
  }

  /** Items whose next attempt is due, oldest first. */
  listDue(now: number, limit = 50): Promise<OutboxRow[]> {
    return this.ctx.sql.getAllAsync<OutboxRow>(
      'SELECT * FROM outbox WHERE next_attempt_at <= ? ORDER BY id LIMIT ?',
      [now, limit],
    );
  }

  listAll(): Promise<OutboxRow[]> {
    return this.ctx.sql.getAllAsync<OutboxRow>('SELECT * FROM outbox ORDER BY id');
  }

  /** Earliest scheduled attempt, or null when the outbox is empty (to arm the worker's timer). */
  async nextAttemptAt(): Promise<number | null> {
    const row = await this.ctx.sql.getFirstAsync<{ t: number | null }>('SELECT MIN(next_attempt_at) AS t FROM outbox');
    return row?.t ?? null;
  }

  async reschedule(id: number, nextAttemptAt: number): Promise<void> {
    await this.ctx.sql.runAsync('UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ?', [
      nextAttemptAt,
      id,
    ]);
    this.ctx.changed(Topics.outbox);
  }

  async delete(id: number): Promise<void> {
    const result = await this.ctx.sql.runAsync('DELETE FROM outbox WHERE id = ?', [id]);
    if (result.changes > 0) this.ctx.changed(Topics.outbox);
  }

  async deleteForMessage(messageId: string): Promise<void> {
    const result = await this.ctx.sql.runAsync(`DELETE FROM outbox WHERE kind = 'message' AND message_id = ?`, [
      messageId,
    ]);
    if (result.changes > 0) this.ctx.changed(Topics.outbox);
  }

  async count(): Promise<number> {
    const row = await this.ctx.sql.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM outbox');
    return row?.n ?? 0;
  }
}

/** Parses an outbox receipt payload written by enqueueReceipt; corrupt rows yield null. */
export function parseReceiptPayload(row: OutboxRow): ReceiptOutboxPayload | null {
  if (row.kind !== 'receipt' || row.payload === null) return null;
  try {
    const p = JSON.parse(row.payload) as Partial<ReceiptOutboxPayload>;
    if (
      typeof p.peer === 'string' &&
      (p.status === 'delivered' || p.status === 'read') &&
      Array.isArray(p.message_ids) &&
      p.message_ids.every((id) => typeof id === 'string')
    ) {
      return { peer: p.peer, status: p.status, message_ids: p.message_ids };
    }
    return null;
  } catch {
    // Only this app writes the column; unparsable JSON means corruption and the caller drops the row.
    return null;
  }
}
