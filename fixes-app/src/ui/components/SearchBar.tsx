import { StyleSheet, TextInput, View } from 'react-native';

import { colors, MIN_TOUCH_SIZE, spacing } from '../theme';
import { Icon } from './Icon';
import { IconButton } from './IconButton';

export interface SearchBarProps {
  value: string;
  onChangeText(text: string): void;
  placeholder?: string;
  /** Discover submits to search; the inbox and friends list filter as you type. */
  onSubmit?(): void;
  maxLength?: number;
  testID?: string;
}

export function SearchBar({ value, onChangeText, placeholder = 'Search..', onSubmit, maxLength, testID }: SearchBarProps) {
  return (
    <View style={styles.bar}>
      <Icon name="search" size={18} color={colors.textMuted} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.placeholder}
        accessibilityLabel={placeholder.replace(/\.+$/, '')}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        onSubmitEditing={onSubmit}
        maxLength={maxLength}
        style={styles.input}
        testID={testID}
      />
      {value.length > 0 ? (
        <IconButton icon="close-circle" accessibilityLabel="Clear search" color={colors.textMuted} size={18} onPress={() => onChangeText('')} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: spacing.md,
    marginVertical: spacing.sm,
    paddingLeft: spacing.md,
    borderRadius: 10,
    backgroundColor: colors.surface,
    minHeight: MIN_TOUCH_SIZE,
  },
  input: { flex: 1, fontSize: 16, color: colors.text, paddingHorizontal: spacing.sm, minHeight: MIN_TOUCH_SIZE },
});
