import type { Repositories } from '../db/localStore';
import type { MessageRow, ReceiptHintStatus } from '../db/types';

/**
 * Receipts that name messages this device does not have yet are kept as hints (§7.2) and applied
 * when the rows appear (live receive, history transfer, backup import). The hint's status carries the
 * receipt's scope, so a peer's receipt can only ever advance my outgoing rows and read sync from my
 * own devices only my incoming rows.
 */

export type HintTarget = Pick<MessageRow, 'id' | 'peer_user_id' | 'direction'>;

/** Stores hints for the ids that do not exist as rows at all (existing rows were handled directly). */
export async function storeHintsForUnknown(
  tx: Repositories,
  ids: readonly string[],
  status: ReceiptHintStatus,
  now: number,
): Promise<void> {
  if (ids.length === 0) return;
  const existing = await tx.messages.existingIds(ids);
  for (const id of ids) {
    if (!existing.has(id)) await tx.receiptHints.put(id, status, now);
  }
}

/**
 * Applies (and removes) the hints of rows that were just inserted. Returns the peers whose incoming
 * rows moved to `read`, whose unread counts the caller must recount.
 */
export async function applyReceiptHints(tx: Repositories, rows: readonly HintTarget[]): Promise<Set<string>> {
  const readPeers = new Set<string>();
  const byId = new Map(rows.filter((r) => r.direction !== 'system').map((r) => [r.id, r]));
  if (byId.size === 0) return readPeers;
  for (const hint of await tx.receiptHints.take([...byId.keys()])) {
    const row = byId.get(hint.message_id);
    if (!row) continue;
    if (hint.status === 'read_sync') {
      if (row.direction !== 'in') continue;
      const changed = await tx.messages.updateStatusForward({
        peerUserId: row.peer_user_id,
        direction: 'in',
        status: 'read',
        ids: [row.id],
      });
      if (changed.length > 0) readPeers.add(row.peer_user_id);
    } else if (row.direction === 'out') {
      await tx.messages.updateStatusForward({
        peerUserId: row.peer_user_id,
        direction: 'out',
        status: hint.status,
        ids: [row.id],
      });
    }
  }
  return readPeers;
}
