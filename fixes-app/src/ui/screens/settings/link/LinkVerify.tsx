import { StyleSheet, Text, View } from 'react-native';

import type { MyDevice } from '../../../../core/api/types';
import { relativeTime } from '../../../../core/utils/relativeTime';
import { Button, ErrorState, Icon, LoadingState } from '../../../components';
import { colors, spacing, typography } from '../../../theme';

/** The scanned device as `GET /v1/devices` reports it (§9 step 3), checked before anything is sent. */
export type LinkCheck =
  | { status: 'loading' }
  | { status: 'ok'; device: MyDevice; alreadyLinked: boolean }
  | { status: 'error'; message: string };

export interface LinkVerifyProps {
  check: LinkCheck;
  now: number;
  onConfirm(): void;
  onCancel(): void;
}

/**
 * Verification step between scanning and linking: the code names a device of this account with
 * exactly the scanned key; the user confirms it is the phone in front of them before it receives the
 * identity key and the whole history.
 */
export function LinkVerify({ check, now, onConfirm, onCancel }: LinkVerifyProps) {
  if (check.status === 'loading') return <LoadingState label="Checking the new device" />;
  if (check.status === 'error') {
    return (
      <View style={styles.box}>
        <ErrorState message={check.message} testID="link-verify-error" />
        <Button title="Scan again" variant="secondary" onPress={onCancel} testID="link-scan-again" />
      </View>
    );
  }
  const created = Date.parse(check.device.created_at);
  const since = Number.isNaN(created) ? null : relativeTime(created, { now: () => now });
  return (
    <View style={styles.box} testID="link-verify">
      <Icon name="phone-portrait-outline" size={48} color={colors.text} />
      <Text style={styles.heading} accessibilityRole="header">
        Link this device?
      </Text>
      <Text style={styles.name} testID="link-verify-name">
        {check.device.name}
      </Text>
      {since ? <Text style={styles.caption}>{`Logged in ${since}`}</Text> : null}
      {check.alreadyLinked ? (
        <Text style={styles.body}>This device is already linked. Continuing sends your message history to it again.</Text>
      ) : null}
      <Text style={styles.warning}>
        Only continue if this is the device in front of you. It will be able to read all your messages and receives
        your message history now.
      </Text>
      <Button title="Link device" onPress={onConfirm} testID="link-confirm" style={styles.wide} />
      <Button title="Cancel" variant="link" onPress={onCancel} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', gap: spacing.md, padding: spacing.xl },
  heading: { ...typography.title },
  name: { ...typography.heading, fontSize: 20 },
  caption: { ...typography.caption, fontSize: 14 },
  body: { ...typography.body, textAlign: 'center' },
  warning: { ...typography.body, textAlign: 'center', fontWeight: '600' },
  wide: { alignSelf: 'stretch' },
});
