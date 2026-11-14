import { useEffect } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useFixes } from '../../../hooks';
import { Button, Icon, LinkQrCard } from '../../components';
import { useLinkQr } from '../../hooks/useLinkQr';
import type { RootScreenProps } from '../../navigation/types';
import { colors, spacing, statusColors, typography } from '../../theme';

/**
 * An already linked device receives its history again (§13 gap banner: "link it again from another
 * device to recover history"): it shows a link code like a new device, the other device scans it under
 * "Link a new device" and sends `link` + `history`, merged by the §10 rules.
 */
export function ReceiveHistoryScreen({ navigation }: RootScreenProps<'ReceiveHistory'>) {
  const { messaging } = useFixes();
  const { incoming, error, created, newCode, cancelIncoming } = useLinkQr();

  // Leaving before anything arrived abandons the transfer, so its secret does not stay usable.
  useEffect(
    () => () => {
      if (messaging.incomingLink.get().phase !== 'waiting') return;
      cancelIncoming().catch((caught: unknown) => console.warn('Could not cancel the history transfer', caught));
    },
    [messaging, cancelIncoming],
  );

  // Until the engine answered, the state may still describe an earlier transfer.
  if (created && incoming.phase === 'complete') {
    const added = incoming.imported.messagesAdded;
    return (
      <View style={[styles.page, styles.done]} testID="receive-history-done">
        <Icon name="checkmark-circle" size={56} color={statusColors.delivered} />
        <Text style={styles.title} accessibilityRole="header">
          History received
        </Text>
        <Text style={styles.body}>{added === 1 ? '1 message was added.' : `${added} messages were added.`}</Text>
        <Button title="Done" onPress={() => navigation.goBack()} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Text style={styles.body}>
        Use this when this device is missing messages. On a device that has your full history, open Profile → Settings →
        Link a new device and scan this code.
      </Text>
      <LinkQrCard
        qr={created ? incoming.qr : null}
        error={error}
        expired={created && incoming.phase === 'expired'}
        onNewCode={newCode}
      />
      {created && incoming.phase === 'receiving' ? (
        <View style={styles.progress} accessibilityLiveRegion="polite" testID="receive-history-progress">
          <ActivityIndicator color={colors.black} />
          <Text style={styles.body}>
            {incoming.totalChunks !== null
              ? `Receiving your history… ${incoming.receivedChunks} of ${incoming.totalChunks}`
              : 'Receiving your history…'}
          </Text>
        </View>
      ) : null}
      <Text style={styles.hint}>Keep both devices open until the transfer finishes.</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.white },
  content: { padding: spacing.xl, gap: spacing.md },
  done: { alignItems: 'center', justifyContent: 'center', gap: spacing.md, padding: spacing.xl },
  title: { ...typography.title },
  body: { ...typography.body, textAlign: 'center' },
  hint: { ...typography.caption, textAlign: 'center' },
  progress: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
});
