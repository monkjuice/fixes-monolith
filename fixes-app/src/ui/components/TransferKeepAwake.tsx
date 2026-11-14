import { useKeepAwake } from 'expo-keep-awake';

import type { IncomingTransferPhase } from '../../core/linking/incoming';
import type { OutgoingLinkPhase } from '../../core/linking/outgoing';
import { useLinkTransfer } from '../../hooks';
import { isOutgoingLinkRunning } from '../presentation/linkProgress';

/** §9 step 4: the screen stays awake while history is being sent or received. */
export function isTransferRunning(incoming: IncomingTransferPhase, outgoing: OutgoingLinkPhase): boolean {
  return incoming === 'receiving' || isOutgoingLinkRunning(outgoing);
}

const KEEP_AWAKE_TAG = 'fixes-history-transfer';

function KeepAwake() {
  useKeepAwake(KEEP_AWAKE_TAG);
  return null;
}

/**
 * Mounted once at the root rather than on the linking screens: the new device leaves "Link this
 * device" as soon as the `link` envelope arrives, while its history keeps arriving.
 */
export function TransferKeepAwake() {
  const { incoming, outgoing } = useLinkTransfer();
  return isTransferRunning(incoming.phase, outgoing.phase) ? <KeepAwake /> : null;
}
