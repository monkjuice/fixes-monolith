import { StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from '../theme';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';
import { IconButton } from './IconButton';

export interface BannerProps {
  text: string;
  tone?: 'info' | 'warning';
  icon?: IconName;
  actions?: { title: string; onPress(): void; busy?: boolean }[];
  /** Shows a close button. */
  onDismiss?(): void;
  testID?: string;
}

/** A notice above a list (gap, safety-code change, history transfer, connection). */
export function Banner({ text, tone = 'info', icon, actions, onDismiss, testID }: BannerProps) {
  return (
    <View style={[styles.banner, tone === 'warning' ? styles.warning : styles.info]} testID={testID} accessibilityRole="alert">
      <View style={styles.row}>
        {icon ? <Icon name={icon} size={20} color={colors.text} /> : null}
        <Text style={styles.text}>{text}</Text>
        {onDismiss ? <IconButton icon="close" accessibilityLabel="Dismiss" color={colors.text} size={20} onPress={onDismiss} /> : null}
      </View>
      {actions && actions.length > 0 ? (
        <View style={styles.actions}>
          {actions.map((action) => (
            <Button key={action.title} title={action.title} onPress={action.onPress} busy={action.busy} variant="secondary" />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderLeftWidth: 4 },
  info: { backgroundColor: colors.surface, borderLeftColor: colors.black },
  warning: { backgroundColor: colors.warningBackground, borderLeftColor: colors.warningBorder },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  text: { flex: 1, fontSize: 14, color: colors.text, paddingVertical: spacing.xs },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.xs },
});
