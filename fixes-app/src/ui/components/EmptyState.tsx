import { StyleSheet, Text, View } from 'react-native';

import { colors, spacing, typography } from '../theme';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';

export interface EmptyStateProps {
  icon: IconName;
  title: string;
  message?: string;
  action?: { title: string; onPress(): void };
  testID?: string;
}

export function EmptyState({ icon, title, message, action, testID }: EmptyStateProps) {
  return (
    <View style={styles.container} testID={testID}>
      <Icon name={icon} size={48} color={colors.border} />
      <Text style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      {message ? <Text style={styles.message}>{message}</Text> : null}
      {action ? <Button title={action.title} onPress={action.onPress} variant="secondary" style={styles.action} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', justifyContent: 'center', padding: spacing.xxl, gap: spacing.sm },
  title: { ...typography.heading, textAlign: 'center' },
  message: { ...typography.body, color: colors.textMuted, textAlign: 'center' },
  action: { marginTop: spacing.md },
});
