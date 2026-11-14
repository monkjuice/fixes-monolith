import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { colors, spacing, typography } from '../theme';
import { Button } from './Button';

const QR_SIZE = 240;

export interface LinkQrCardProps {
  /** The `fixes-link:1:…` text (§9 step 2), null while it is being created. */
  qr: string | null;
  /** Creating the code failed. */
  error: string | null;
  /** The transfer expired (§9 step 5): offer a new code. */
  expired: boolean;
  onNewCode(): void;
}

/**
 * The link code the other device scans ("Link this device" and "Receive history"). It carries the
 * transfer secret, so it is only ever shown, never shared or copied.
 */
export function LinkQrCard({ qr, error, expired, onNewCode }: LinkQrCardProps) {
  let content;
  if (error) {
    content = (
      <View style={styles.center}>
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
        <Button title="Try again" variant="secondary" onPress={onNewCode} />
      </View>
    );
  } else if (expired) {
    content = (
      <View style={styles.center}>
        <Text style={styles.error} accessibilityRole="alert">
          Transfer incomplete, retry.
        </Text>
        <Button title="Show a new code" variant="secondary" onPress={onNewCode} testID="link-new-code" />
      </View>
    );
  } else if (qr) {
    content = (
      <View accessible accessibilityRole="image" accessibilityLabel="Link code to scan with your other device" testID="link-qr">
        <QRCode value={qr} size={QR_SIZE} ecl="M" color={colors.black} backgroundColor={colors.white} />
      </View>
    );
  } else {
    content = <ActivityIndicator color={colors.black} accessibilityLabel="Preparing the link code" />;
  }
  return <View style={styles.box}>{content}</View>;
}

const styles = StyleSheet.create({
  box: {
    alignSelf: 'center',
    width: QR_SIZE + 2 * spacing.lg,
    minHeight: QR_SIZE + 2 * spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: spacing.lg,
    padding: spacing.lg,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
  },
  center: { alignItems: 'center', gap: spacing.md },
  error: { ...typography.body, color: colors.danger, textAlign: 'center' },
});
