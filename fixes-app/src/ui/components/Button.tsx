import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';

import { colors, MIN_TOUCH_SIZE, spacing } from '../theme';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'link';

export interface ButtonProps {
  title: string;
  onPress(): void;
  variant?: ButtonVariant;
  disabled?: boolean;
  /** Work in progress: announced as busy and not pressable. */
  busy?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled = false,
  busy = false,
  accessibilityLabel,
  accessibilityHint,
  style,
  testID,
}: ButtonProps) {
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        variantStyles[variant],
        inactive && variant !== 'link' && styles.inactive,
        pressed && styles.pressed,
        style,
      ]}
    >
      <Text style={[styles.label, labelStyles[variant], inactive && variant === 'link' && styles.inactiveLink]}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: MIN_TOUCH_SIZE,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { fontSize: 17, fontWeight: '600', textAlign: 'center' },
  // Legacy: the login button turned LightGray while working.
  inactive: { backgroundColor: colors.border, borderColor: colors.border },
  inactiveLink: { color: colors.textMuted },
  pressed: { opacity: 0.7 },
});

const variantStyles = StyleSheet.create({
  primary: { backgroundColor: colors.black },
  secondary: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.black },
  danger: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.danger },
  link: { backgroundColor: 'transparent', paddingHorizontal: spacing.sm },
});

const labelStyles = StyleSheet.create({
  primary: { color: colors.white },
  secondary: { color: colors.black },
  danger: { color: colors.danger },
  link: { color: colors.black, fontSize: 15, fontWeight: '400', textDecorationLine: 'underline' },
});
