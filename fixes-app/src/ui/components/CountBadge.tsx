import { StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme';

/** Small red count (pending friend requests); nothing at 0. Decorative: rows announce the count. */
export function CountBadge({ count, testID }: { count: number; testID?: string }) {
  if (count <= 0) return null;
  return (
    <View style={styles.badge} importantForAccessibility="no-hide-descendants" accessible={false} testID={testID}>
      <Text style={styles.text}>{count > 99 ? '99+' : String(count)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 6,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { color: colors.white, fontSize: 12, fontWeight: '700' },
});
