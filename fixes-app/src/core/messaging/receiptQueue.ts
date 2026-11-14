import type { Repositories } from '../db/localStore';
import { parseReceiptPayload as parseOutboxReceipt } from '../db/repositories/outbox';
import { MAX_RECEIPT_IDS, type ReceiptStatus } from '../payloads/receipt';

/**
 * Queues a receipt in the outbox, coalesced per (peer, status) (protocol §7.2). The first receipt of a
 * burst opens a window of `debounceMs` (its row is due only then); later ids within the window are
 * merged into that row, up to 500 ids per receipt. Rows inside the window are never being sent: the
 * worker marks a row attempted (claims it) before sending it, also when the logout flush sends it
 * early. Runs inside the caller's transaction, so receipts are durable together
 * with the state change that caused them.
 */
export async function queueReceipt(
  tx: Repositories,
  params: { peer: string; status: ReceiptStatus; ids: readonly string[]; now: number; debounceMs: number },
): Promise<void> {
  let remaining = [...new Set(params.ids)];
  if (remaining.length === 0) return;
  for (const row of await tx.outbox.listReceiptsAwaitingDebounce(params.now)) {
    const payload = parseOutboxReceipt(row);
    if (!payload || payload.peer !== params.peer || payload.status !== params.status) continue;
    const present = new Set(payload.message_ids);
    const additions = remaining.filter((id) => !present.has(id));
    const room = MAX_RECEIPT_IDS - payload.message_ids.length;
    const taken = additions.slice(0, Math.max(0, room));
    if (taken.length > 0) {
      await tx.outbox.updateReceiptPayload(row.id, { ...payload, message_ids: [...payload.message_ids, ...taken] });
    }
    const takenSet = new Set(taken);
    remaining = additions.filter((id) => !takenSet.has(id));
    if (remaining.length === 0) return;
  }
  for (let i = 0; i < remaining.length; i += MAX_RECEIPT_IDS) {
    await tx.outbox.enqueueReceipt(
      { peer: params.peer, status: params.status, message_ids: remaining.slice(i, i + MAX_RECEIPT_IDS) },
      params.now,
      params.now + params.debounceMs,
    );
  }
}
