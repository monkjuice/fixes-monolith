import { useMemo, useSyncExternalStore } from 'react';

import type { IncomingTransferState } from '../core/linking/incoming';
import type { OutgoingLinkState } from '../core/linking/outgoing';
import { useFixes } from './FixesContext';

export interface LinkTransfer {
  /** This device as the new one: the QR to show and the progress of the received history. */
  incoming: IncomingTransferState;
  /** This device linking another one (after scanning its QR): phases and chunk progress. */
  outgoing: OutgoingLinkState;
  /** The QR text for "Link this device" (same code while the transfer is open). */
  createQr(): Promise<string>;
  cancelIncoming(): Promise<void>;
  /** Links the device whose QR was scanned; the outcome arrives in `outgoing`. */
  startLink(qrText: string): Promise<void>;
  resend(): Promise<void>;
  cancel(): void;
  reset(): void;
}

/**
 * Both sides of device linking (§9). Keeping the screen awake during a transfer is the screen's job:
 * keep it awake while `outgoing.phase` is one of the sending phases or `incoming.phase === 'receiving'`.
 */
export function useLinkTransfer(): LinkTransfer {
  const { messaging } = useFixes();
  const incoming = useSyncExternalStore(messaging.incomingLink.subscribe, messaging.incomingLink.get, messaging.incomingLink.get);
  const outgoing = useSyncExternalStore(messaging.outgoingLink.subscribe, messaging.outgoingLink.get, messaging.outgoingLink.get);
  const actions = useMemo(
    () => ({
      createQr: () => messaging.createLinkQr(),
      cancelIncoming: () => messaging.cancelIncomingLink(),
      startLink: (qrText: string) => messaging.startLink(qrText),
      resend: () => messaging.resendLink(),
      cancel: () => messaging.cancelLink(),
      reset: () => messaging.resetLink(),
    }),
    [messaging],
  );
  return useMemo(() => ({ incoming, outgoing, ...actions }), [incoming, outgoing, actions]);
}
