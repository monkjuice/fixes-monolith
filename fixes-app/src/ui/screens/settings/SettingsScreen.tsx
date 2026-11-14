import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { useFixes } from '../../../hooks';
import { confirm, InlineError, ListItem, useToast } from '../../components';
import type { RootScreenProps } from '../../navigation/types';
import { describeError } from '../../presentation/errors';
import { colors, spacing, typography } from '../../theme';

/**
 * §12.1 "Erase this device", behind two confirmations: it deletes the database and every key of the
 * account on this phone. The session then becomes signed out and the Login screen says so.
 */
function useEraseDevice() {
  const { session } = useFixes();
  const showToast = useToast();
  const [erasing, setErasing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const erase = async () => {
    if (erasing) return;
    const first = await confirm({
      title: 'Erase this device?',
      message:
        'This deletes all your messages and keys from this phone and signs it out. Messages that exist only on this phone are lost unless you have a backup or another linked device.',
      confirmText: 'Continue',
      destructive: true,
    });
    if (!first) return;
    const second = await confirm({
      title: 'Erase everything on this phone?',
      message: 'This cannot be undone.',
      confirmText: 'Erase',
      destructive: true,
    });
    if (!second) return;
    setErasing(true);
    setError(null);
    try {
      const { serverRevoked } = await session.eraseDevice();
      // The toast outlives this screen: the root navigator switches to Login right away.
      showToast(
        serverRevoked
          ? 'This device was erased.'
          : 'This device was erased, but it could not be signed out on the server. Remove it under Settings → Devices on another device.',
      );
    } catch (caught) {
      setError(describeError(caught));
      setErasing(false);
    }
  };

  return { erase, erasing, error };
}

/** §14 Settings: Devices, Link a new device, Backups, Change password, Erase this device. */
export function SettingsScreen({ navigation }: RootScreenProps<'Settings'>) {
  const { erase, erasing, error } = useEraseDevice();
  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Text style={styles.section} accessibilityRole="header">
        Devices
      </Text>
      <View style={styles.group}>
        <ListItem
          icon="phone-portrait-outline"
          title="Devices"
          subtitle="Your devices, which are linked, remove one"
          onPress={() => navigation.navigate('Devices')}
          testID="settings-devices"
        />
        <ListItem
          icon="qr-code-outline"
          title="Link a new device"
          subtitle="Scan the code shown by your new device"
          onPress={() => navigation.navigate('LinkDevice')}
          testID="settings-link-device"
        />
        <ListItem
          icon="download-outline"
          title="Receive history"
          subtitle="Get your messages again from another linked device"
          onPress={() => navigation.navigate('ReceiveHistory')}
          testID="settings-receive-history"
        />
      </View>

      <Text style={styles.section} accessibilityRole="header">
        Data and account
      </Text>
      <View style={styles.group}>
        <ListItem
          icon="cloud-upload-outline"
          title="Backups"
          subtitle="Encrypted backup file and recovery key"
          onPress={() => navigation.navigate('Backup')}
          testID="settings-backup"
        />
        <ListItem
          icon="key-outline"
          title="Change password"
          onPress={() => navigation.navigate('ChangePassword')}
          testID="settings-change-password"
        />
        <ListItem
          icon="trash-outline"
          title={erasing ? 'Erasing..' : 'Erase this device'}
          subtitle="Delete all messages and keys from this phone"
          danger
          disabled={erasing}
          onPress={() => void erase()}
          testID="settings-erase"
        />
      </View>
      <InlineError message={error} testID="settings-error" />

      <Text style={styles.section} accessibilityRole="header">
        Privacy
      </Text>
      <Text style={styles.note}>
        Messages are end-to-end encrypted. The Fixes server only relays encrypted envelopes and deletes each one once
        your device has received it (at the latest after 30 days). It never sees message contents, your history,
        backups or your recovery key. It does know your username, profile photo, friends, devices, and who sends
        messages to whom and when.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.white },
  content: { paddingBottom: spacing.xxl },
  section: {
    ...typography.caption,
    fontWeight: '700',
    textTransform: 'uppercase',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.sm,
  },
  group: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  note: { ...typography.body, color: colors.textMuted, paddingHorizontal: spacing.lg },
});
