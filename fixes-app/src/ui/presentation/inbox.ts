import type { InboxRow } from '../../core/db/types';
import { relativeTime } from '../../core/utils/relativeTime';
import { statusColors } from '../theme';
import { outgoingStatus } from './messageStatus';

/** What an inbox row shows (§14), derived from the conversation's newest non-system message. */
export interface InboxPreview {
  /** '→' outgoing, '←' incoming, null when the conversation has no message yet. */
  arrow: '→' | '←' | null;
  arrowColor: string;
  /** Bold when the newest message is incoming and still unread. */
  bold: boolean;
  /** Failed outgoing message: show the retry icon. */
  failed: boolean;
  preview: string | null;
  /** Spoken status of the newest message ("Read", "Unread"…), null without one. */
  statusLabel: string | null;
  time: string;
}

export function inboxPreview(row: InboxRow, now: number): InboxPreview {
  const time = relativeTime(row.last_sort_ts ?? row.last_activity_at, { now: () => now });
  if (row.last_direction === 'in') {
    const unread = row.last_status === 'received';
    return {
      arrow: '←',
      arrowColor: statusColors.incoming,
      bold: unread,
      failed: false,
      preview: row.last_body,
      statusLabel: unread ? 'Unread' : 'Received',
      time,
    };
  }
  if (row.last_direction === 'out') {
    const status = row.last_status ? outgoingStatus(row.last_status) : null;
    return {
      arrow: '→',
      arrowColor: status?.color ?? statusColors.sent,
      bold: false,
      failed: row.last_status === 'failed',
      preview: row.last_body,
      statusLabel: status?.label ?? null,
      time,
    };
  }
  return { arrow: null, arrowColor: statusColors.incoming, bold: false, failed: false, preview: null, statusLabel: null, time };
}

/** §14 inbox search: local, case-insensitive substring match on the username. */
export function filterByUsername<T extends { peer_username: string }>(rows: readonly T[], query: string): readonly T[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return rows;
  return rows.filter((row) => row.peer_username.toLowerCase().includes(needle));
}
