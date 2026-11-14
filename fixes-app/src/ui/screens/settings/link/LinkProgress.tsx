import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import type { OutgoingLinkState } from '../../../../core/linking/outgoing';
import { Button, Icon, ProgressBar } from '../../../components';
import { isOutgoingLinkRunning, outgoingLinkProgress, outgoingLinkText } from '../../../presentation/linkProgress';
import { colors, spacing, statusColors, typography } from '../../../theme';

export interface LinkProgressProps {
  state: OutgoingLinkState;
  onCancel(): void;
  onResend(): void;
  onScanAgain(): void;
  onDone(): void;
}

/** §9 step 4 on the linked device: progress, then done or a visible error with Resend when possible. */
export function LinkProgress({ state, onCancel, onResend, onScanAgain, onDone }: LinkProgressProps) {
  const text = outgoingLinkText(state);

  if (state.phase === 'done') {
    return (
      <View style={styles.box} testID="link-done">
        <Icon name="checkmark-circle" size={56} color={statusColors.delivered} />
        <Text style={styles.heading} accessibilityRole="header">
          Device linked
        </Text>
        <Text style={styles.body}>{text}</Text>
        <Button title="Done" onPress={onDone} style={styles.wide} testID="link-finish" />
      </View>
    );
  }

  if (state.phase === 'failed') {
    return (
      <View style={styles.box} testID="link-failed">
        <Icon name="alert-circle" size={56} color={colors.danger} />
        <Text style={styles.error} accessibilityRole="alert">
          {text}
        </Text>
        {state.canResend ? (
          <>
            <Text style={styles.body}>The new device keeps what it already received. Resend sends everything again.</Text>
            <Button title="Resend" onPress={onResend} style={styles.wide} testID="link-resend" />
          </>
        ) : null}
        <Button title="Scan again" variant="secondary" onPress={onScanAgain} style={styles.wide} testID="link-scan-again" />
        <Button title="Close" variant="link" onPress={onDone} />
      </View>
    );
  }

  const running = isOutgoingLinkRunning(state.phase);
  return (
    <View style={styles.box} testID="link-progress">
      <ActivityIndicator color={colors.black} size="large" />
      <Text style={styles.body} accessibilityLiveRegion="polite" testID="link-progress-text">
        {text}
      </Text>
      <ProgressBar progress={outgoingLinkProgress(state)} label="Linking progress" />
      <Text style={styles.hint}>Keep both devices open and nearby until the transfer finishes.</Text>
      {running ? <Button title="Cancel" variant="secondary" onPress={onCancel} testID="link-cancel" /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', gap: spacing.md, padding: spacing.xl },
  heading: { ...typography.title },
  body: { ...typography.body, textAlign: 'center' },
  hint: { ...typography.caption, textAlign: 'center' },
  error: { ...typography.body, color: colors.danger, textAlign: 'center' },
  wide: { alignSelf: 'stretch' },
});
