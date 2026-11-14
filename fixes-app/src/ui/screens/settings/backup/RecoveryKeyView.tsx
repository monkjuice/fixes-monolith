import { Platform, StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from '../../../theme';

const MONOSPACE = Platform.select({ ios: 'Menlo', default: 'monospace' });

/**
 * The recovery key (§4.3: 24 Crockford base32 characters in 6 groups of 4), large and monospaced so it
 * can be copied by hand. Deliberately not selectable: it should not end up in the clipboard.
 */
export function RecoveryKeyView({ recoveryKey, testID }: { recoveryKey: string; testID?: string }) {
  const groups = recoveryKey.split('-');
  return (
    <View style={styles.box} accessible accessibilityLabel={`Recovery key: ${groups.map((g) => g.split('').join(' ')).join(', ')}`}>
      <Text style={styles.key} testID={testID}>
        {recoveryKey}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    alignSelf: 'stretch',
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.black,
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  key: { fontFamily: MONOSPACE, fontSize: 19, letterSpacing: 1, textAlign: 'center', color: colors.text },
});
