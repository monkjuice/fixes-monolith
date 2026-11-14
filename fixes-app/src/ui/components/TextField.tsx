import type { Ref } from 'react';
import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

import { colors, MIN_TOUCH_SIZE, spacing } from '../theme';

/**
 * TextInput's maxLength counts UTF-16 units, while passwords may have 128 code points (§3): this cap
 * never cuts a valid password; isValidPassword enforces the real limit.
 */
export const PASSWORD_INPUT_MAX_UNITS = 256;

export interface TextFieldProps extends TextInputProps {
  /** Shown as the placeholder and used as the accessibility label (the legacy forms had no labels). */
  label: string;
  /** Field-level error, announced with the field. */
  error?: string | null;
  ref?: Ref<TextInput>;
}

/** Legacy Entry look: black text, DimGray placeholder, underline, up to 350 pt wide. */
export function TextField({ label, error, style, ref, ...props }: TextFieldProps) {
  return (
    <View style={styles.container}>
      <TextInput
        ref={ref}
        placeholder={label}
        placeholderTextColor={colors.placeholder}
        accessibilityLabel={label}
        accessibilityHint={error ?? undefined}
        style={[styles.input, error ? styles.inputError : null, style]}
        {...props}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { width: '100%', maxWidth: 350, alignSelf: 'center' },
  input: {
    minHeight: MIN_TOUCH_SIZE,
    fontSize: 17,
    color: colors.text,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingVertical: spacing.sm,
  },
  inputError: { borderBottomColor: colors.danger },
  error: { color: colors.danger, fontSize: 13, marginTop: spacing.xs },
});
