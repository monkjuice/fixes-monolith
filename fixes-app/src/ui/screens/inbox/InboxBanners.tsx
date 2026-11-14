import { useNavigation } from '@react-navigation/native';
import { useState } from 'react';
import { View } from 'react-native';

import { useFixes, useLinkTransfer, useMessagingState, useSession } from '../../../hooks';
import { Banner } from '../../components';
import type { RootNavigation } from '../../navigation/types';

/** §13 gap notice (legacy wording from the protocol). */
export const GAP_TEXT = 'This device missed some messages — link it again from another device to recover history';

/**
 * Notices above the inbox: the mailbox gap, an unreachable server, the history still arriving after
 * this device was linked (§9 step 5), and a local database that had to be set aside (§12.1).
 */
export function InboxBanners() {
  const { messaging } = useFixes();
  const navigation = useNavigation<RootNavigation>();
  const engine = useMessagingState();
  const { localDataReset } = useSession();
  const { incoming, cancelIncoming } = useLinkTransfer();
  const [resetDismissed, setResetDismissed] = useState(false);

  const receiving = incoming.phase === 'receiving';
  const historyText =
    incoming.totalChunks !== null
      ? `Receiving your history from your other device… ${incoming.receivedChunks} of ${incoming.totalChunks}. Keep both devices open.`
      : 'Receiving your history from your other device… Keep both devices open.';

  return (
    <View>
      {engine.gap ? (
        <Banner
          tone="warning"
          icon="warning-outline"
          text={GAP_TEXT}
          actions={[{ title: 'Receive history', onPress: () => navigation.navigate('ReceiveHistory') }]}
          onDismiss={() => messaging.dismissGap()}
          testID="gap-banner"
        />
      ) : null}
      {localDataReset && !resetDismissed ? (
        <Banner
          tone="warning"
          icon="warning-outline"
          text="The messages stored on this phone could not be opened and were set aside. Import a backup, or receive your history from another device, to get them back."
          actions={[
            { title: 'Import backup', onPress: () => navigation.navigate('Backup') },
            { title: 'Receive history', onPress: () => navigation.navigate('ReceiveHistory') },
          ]}
          onDismiss={() => setResetDismissed(true)}
          testID="local-data-reset-banner"
        />
      ) : null}
      {engine.connection === 'backoff' ? (
        <Banner
          icon="cloud-offline-outline"
          text="Connecting… Messages are sent when the connection is back."
          testID="offline-banner"
        />
      ) : null}
      {receiving ? <Banner icon="sync-outline" text={historyText} testID="history-banner" /> : null}
      {incoming.phase === 'expired' ? (
        <Banner
          tone="warning"
          icon="warning-outline"
          text="Transfer incomplete: some earlier messages may be missing on this device. They are still on your other device."
          onDismiss={() => {
            cancelIncoming().catch((error: unknown) => console.warn('Could not dismiss the transfer notice', error));
          }}
          testID="history-expired-banner"
        />
      ) : null}
    </View>
  );
}
