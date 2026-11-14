import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { colors, spacing, typography } from '../theme';
import { Button } from './Button';

export interface LoadingStateProps {
  /** Spoken by screen readers ("Loading friends"). */
  label: string;
  testID?: string;
}

/** Centred spinner for a screen or list that has nothing to show yet. */
export function LoadingState({ label, testID }: LoadingStateProps) {
  return (
    <View style={styles.box} testID={testID}>
      <ActivityIndicator color={colors.black} size="large" accessibilityLabel={label} />
    </View>
  );
}

export interface ErrorStateProps {
  message: string;
  onRetry?(): void;
  testID?: string;
}

/** A failed load with its reason and, when it can help, a Retry button. */
export function ErrorState({ message, onRetry, testID }: ErrorStateProps) {
  return (
    <View style={styles.box} testID={testID}>
      <Text style={styles.error} accessibilityRole="alert">
        {message}
      </Text>
      {onRetry ? <Button title="Retry" variant="secondary" onPress={onRetry} /> : null}
    </View>
  );
}

/** One-line error under a form or above a list that still shows older data. */
export function InlineError({ message, testID }: { message: string | null; testID?: string }) {
  if (!message) return null;
  return (
    <Text style={styles.inline} accessibilityRole="alert" testID={testID}>
      {message}
    </Text>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', justifyContent: 'center', gap: spacing.md, padding: spacing.xl, marginTop: spacing.lg },
  error: { ...typography.body, color: colors.danger, textAlign: 'center' },
  inline: { ...typography.body, color: colors.danger, textAlign: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
});
