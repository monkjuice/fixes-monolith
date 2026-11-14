import { Topics } from '../changes';
import type { RepoContext } from '../context';
import type { HistoryTransferRow } from '../types';

type RawTransferRow = Omit<HistoryTransferRow, 'received_seqs'> & { received_seqs: string };

function parseSeqs(text: string): number[] {
  try {
    const value: unknown = JSON.parse(text);
    if (Array.isArray(value) && value.every((n) => Number.isSafeInteger(n) && n >= 0)) return value as number[];
  } catch (error) {
    // Treated as "nothing received", which only costs a resend; reported because only this app writes it.
    console.warn('Corrupt history_transfers.received_seqs column', error);
    return [];
  }
  console.warn('Unexpected history_transfers.received_seqs content');
  return [];
}

function toRow(raw: RawTransferRow | null): HistoryTransferRow | null {
  return raw ? { ...raw, received_seqs: parseSeqs(raw.received_seqs) } : null;
}

/** State of incoming history transfers on the new device (protocol §9 steps 2 and 5). */
export class HistoryTransfersRepository {
  constructor(private readonly ctx: RepoContext) {}

  async create(transferId: string, transferKeyB64: string, now: number): Promise<void> {
    await this.ctx.sql.runAsync(
      `INSERT INTO history_transfers (transfer_id, transfer_key, created_at, last_activity_at) VALUES (?, ?, ?, ?)`,
      [transferId, transferKeyB64, now, now],
    );
    this.ctx.changed(Topics.transfers);
  }

  async get(transferId: string): Promise<HistoryTransferRow | null> {
    return toRow(
      await this.ctx.sql.getFirstAsync<RawTransferRow>('SELECT * FROM history_transfers WHERE transfer_id = ?', [
        transferId,
      ]),
    );
  }

  async listOpen(): Promise<HistoryTransferRow[]> {
    const rows = await this.ctx.sql.getAllAsync<RawTransferRow>(
      'SELECT * FROM history_transfers WHERE completed_at IS NULL ORDER BY created_at',
    );
    return rows.map((r) => toRow(r)!);
  }

  /**
   * Binds (or re-binds, for a new attempt) the transfer; already imported rows stay, seqs restart.
   * `total` is null when the binding comes from the `link` envelope (history chunks set it).
   */
  async bindAttempt(
    transferId: string,
    senderDeviceId: string,
    attemptId: string,
    total: number | null,
    now: number,
  ): Promise<void> {
    await this.ctx.sql.runAsync(
      `UPDATE history_transfers
       SET sender_device_id = ?, attempt_id = ?, total = ?, received_seqs = '[]', last_activity_at = ?
       WHERE transfer_id = ? AND completed_at IS NULL`,
      [senderDeviceId, attemptId, total, now, transferId],
    );
    this.ctx.changed(Topics.transfers);
  }

  /** Adds `seq` to received_seqs (idempotent) and returns the updated row. */
  recordSeq(transferId: string, seq: number, now: number): Promise<HistoryTransferRow | null> {
    return this.ctx.atomic(async (ctx) => {
      const row = await new HistoryTransfersRepository(ctx).get(transferId);
      if (!row) return null;
      const seqs = row.received_seqs.includes(seq) ? row.received_seqs : [...row.received_seqs, seq].sort((a, b) => a - b);
      await ctx.sql.runAsync('UPDATE history_transfers SET received_seqs = ?, last_activity_at = ? WHERE transfer_id = ?', [
        JSON.stringify(seqs),
        now,
        transferId,
      ]);
      ctx.changed(Topics.transfers);
      return { ...row, received_seqs: seqs, last_activity_at: now };
    });
  }

  /** Records activity without changing the binding (restarts the §9 inactivity timer). */
  async touch(transferId: string, now: number): Promise<void> {
    const result = await this.ctx.sql.runAsync(
      'UPDATE history_transfers SET last_activity_at = ? WHERE transfer_id = ? AND completed_at IS NULL',
      [now, transferId],
    );
    if (result.changes > 0) this.ctx.changed(Topics.transfers);
  }

  /** Marks completion and deletes the transfer key (§9 step 5). */
  async complete(transferId: string, now: number): Promise<void> {
    await this.ctx.sql.runAsync(
      'UPDATE history_transfers SET transfer_key = NULL, completed_at = ?, last_activity_at = ? WHERE transfer_id = ?',
      [now, now, transferId],
    );
    this.ctx.changed(Topics.transfers);
  }

  async delete(transferId: string): Promise<void> {
    await this.ctx.sql.runAsync('DELETE FROM history_transfers WHERE transfer_id = ?', [transferId]);
    this.ctx.changed(Topics.transfers);
  }
}
