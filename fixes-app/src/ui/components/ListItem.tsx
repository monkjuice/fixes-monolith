import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, MIN_TOUCH_SIZE, spacing } from '../theme';
import { CountBadge } from './CountBadge';
import { Icon, type IconName } from './Icon';

export interface ListItemProps {
  title: string;
  onPress(): void;
  icon?: IconName;
  subtitle?: string;
  /** Unread/incoming count shown before the chevron (hidden at 0). */
  badge?: number;
  /** Red text for destructive entries (Erase this device). */
  danger?: boolean;
  disabled?: boolean;
  testID?: string;
}

/** A settings-style row: icon, title, optional subtitle and badge, chevron. */
export function ListItem({ title, onPress, icon, subtitle, badge = 0, danger = false, disabled = false, testID }: ListItemProps) {
  const tint = danger ? colors.danger : colors.text;
  const label = [title, badge > 0 ? `${badge} new` : null, subtitle ?? null].filter((part) => part !== null).join(', ');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [styles.row, pressed && styles.pressed, disabled && styles.disabled]}
    >
      {icon ? <Icon name={icon} size={22} color={tint} /> : null}
      <View style={styles.text}>
        <Text style={[styles.title, { color: tint }]}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      <CountBadge count={badge} />
      <Icon name="chevron-forward" size={18} color={colors.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: MIN_TOUCH_SIZE + spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.white,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  pressed: { backgroundColor: colors.surface },
  disabled: { opacity: 0.4 },
  text: { flex: 1 },
  title: { fontSize: 16 },
  subtitle: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
});
