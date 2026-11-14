import type { MessageStatus } from '../../core/db/types';
import { statusColors } from '../theme';

/** How a message status is shown: §14 colour, a tick icon (Ionicons name) and a spoken label. */
export interface StatusPresentation {
  color: string;
  icon: 'time-outline' | 'checkmark' | 'checkmark-done' | 'alert-circle' | null;
  label: string;
}

const OUTGOING: Record<'pending' | 'sent' | 'delivered' | 'read' | 'failed', StatusPresentation> = {
  pending: { color: statusColors.pending, icon: 'time-outline', label: 'Sending' },
  sent: { color: statusColors.sent, icon: 'checkmark', label: 'Sent' },
  delivered: { color: statusColors.delivered, icon: 'checkmark-done', label: 'Delivered' },
  read: { color: statusColors.read, icon: 'checkmark-done', label: 'Read' },
  failed: { color: statusColors.failed, icon: 'alert-circle', label: 'Not sent' },
};

/** Ticks for my own messages; incoming and system rows have none. */
export function outgoingStatus(status: MessageStatus): StatusPresentation | null {
  switch (status) {
    case 'pending':
    case 'sent':
    case 'delivered':
    case 'read':
    case 'failed':
      return OUTGOING[status];
    default:
      return null;
  }
}
