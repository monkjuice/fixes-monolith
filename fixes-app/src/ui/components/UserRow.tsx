import { memo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { User } from '../../core/api/types';
import { colors, spacing } from '../theme';
import { Avatar } from './Avatar';

export interface UserRowProps {
  user: User;
  onPress(user: User): void;
  /** Extra text under the name ("Request sent", "Friends"…). */
  subtitle?: string;
  /** Trailing content (e.g. Accept / Decline buttons on the friend requests screen). */
  accessory?: ReactNode;
}

/** Legacy UserPreviewCell / ContactPreviewCell: round avatar and bold username. */
export const UserRow = memo(function UserRow({ user, onPress, subtitle, accessory }: UserRowProps) {
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={subtitle ? `${user.username}, ${subtitle}` : user.username}
        onPress={() => onPress(user)}
        style={({ pressed }) => [styles.main, pressed && styles.pressed]}
        testID={`user-${user.id}`}
      >
        <Avatar uri={user.avatar_url} />
        <View style={styles.text}>
          <Text style={styles.username} numberOfLines={1}>
            {user.username}
          </Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        </View>
      </Pressable>
      {accessory ? <View style={styles.accessory}>{accessory}</View> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.white },
  main: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 75,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  pressed: { backgroundColor: colors.surface },
  text: { flex: 1 },
  username: { fontSize: 16, fontWeight: '700', color: colors.text },
  subtitle: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  accessory: { paddingRight: spacing.md, flexDirection: 'row', gap: spacing.sm },
});
