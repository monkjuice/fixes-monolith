import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { IncomingTransferState } from '../../../core/linking/incoming';
import { useSession } from '../../../hooks';
import { Banner, Button, KeyboardAvoidingScreen, LinkQrCard } from '../../components';
import { useLinkQr } from '../../hooks/useLinkQr';
import { useLogout } from '../../hooks/useLogout';
import { colors, spacing, typography } from '../../theme';
import { ResetIdentityPanel } from './ResetIdentityPanel';

function progressText(incoming: IncomingTransferState): string {
  if (!incoming.linkReceived) return 'Linking…';
  if (incoming.totalChunks === null) return 'Linked. Receiving your history…';
  return `Linked. Receiving your history… ${incoming.receivedChunks} of ${incoming.totalChunks}`;
}

/**
 * §9 step 1–2, "Link this device": the session is logged in but this device holds no certificate.
 * Shows the QR the linked device scans and the transfer progress. As soon as the `link` envelope is
 * applied the session becomes 'ready' and the root navigator leaves this screen; the history keeps
 * arriving in the background (the inbox shows its progress, TransferKeepAwake keeps the screen on).
 */
export function NeedsLinkScreen() {
  const session = useSession();
  const { incoming, error: qrError, newCode } = useLinkQr();
  const { logout, busy: loggingOut, error: logoutError } = useLogout();

  // The reset panel's password field is the last item: the keyboard must not cover it (§9 step 1).
  return (
    <KeyboardAvoidingScreen>
      <ScrollView style={styles.page} contentContainerStyle={styles.content}>
        <Text style={styles.title} accessibilityRole="header">
          Link this device
        </Text>
        <Text style={styles.body}>
          {session.user ? `You are logged in as ${session.user.username}. ` : ''}
          Your messages are end-to-end encrypted, so this phone needs to be linked from a device where you already use
          Fixes.
        </Text>
        <Text style={styles.step}>1. Open Fixes on your other device.</Text>
        <Text style={styles.step}>2. Go to Profile → Settings → Link a new device.</Text>
        <Text style={styles.step}>3. Scan this code.</Text>

        {session.localDataReset ? (
          <Banner
            tone="warning"
            text="The messages stored on this phone could not be opened and were set aside. Linking this device brings your history over again."
          />
        ) : null}

        <LinkQrCard qr={incoming.qr} error={qrError} expired={incoming.phase === 'expired'} onNewCode={newCode} />

        {incoming.phase === 'receiving' ? (
          <View style={styles.progress} accessibilityLiveRegion="polite">
            <ActivityIndicator color={colors.black} />
            <Text style={styles.body}>{progressText(incoming)}</Text>
          </View>
        ) : null}
        {incoming.phase === 'receiving' ? <Text style={styles.hint}>Keep both devices open until the transfer finishes.</Text> : null}

        <View style={styles.footer}>
          <ResetIdentityPanel />
          <Button title="Log Out" variant="link" onPress={logout} busy={loggingOut} />
          {logoutError ? <Text style={styles.error}>{logoutError}</Text> : null}
        </View>
      </ScrollView>
    </KeyboardAvoidingScreen>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.white },
  content: { padding: spacing.xl, gap: spacing.sm },
  title: { ...typography.title },
  body: { ...typography.body },
  step: { ...typography.body, marginLeft: spacing.sm },
  hint: { ...typography.caption, textAlign: 'center' },
  progress: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  error: { ...typography.body, color: colors.danger, textAlign: 'center' },
  footer: { marginTop: spacing.xl, gap: spacing.md },
});
