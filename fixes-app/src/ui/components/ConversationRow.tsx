import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { InboxRow } from '../../core/db/types';
import { inboxPreview } from '../presentation/inbox';
import { colors, spacing, statusColors } from '../theme';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

export interface ConversationRowProps {
  row: InboxRow;
  /** Current time for the relative timestamp (from useNow, so every row ticks together). */
  now: number;
  onPress(row: InboxRow): void;
}

/**
 * Legacy ConversationPreviewCell (§14): avatar, username, relative time, then the arrow (→ outgoing,
 * ← incoming) coloured by status and the preview; bold while the newest message is incoming and unread.
 */
export const ConversationRow = memo(function ConversationRow({ row, now, onPress }: ConversationRowProps) {
  const p = inboxPreview(row, now);
  const label = [row.peer_username, p.statusLabel, p.preview ?? 'No messages yet', p.arrow ? p.time : null]
    .filter((part) => part !== null)
    .join(', ');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => onPress(row)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      testID={`conversation-${row.peer_user_id}`}
    >
      <Avatar uri={row.peer_avatar_url} />
      <View style={styles.content}>
        <View style={styles.line}>
          <Text style={[styles.username, p.bold && styles.bold]} numberOfLines={1} testID="conversation-username">
            {row.peer_username}
          </Text>
          {p.arrow ? (
            <Text style={styles.time} testID="conversation-time">
              {p.time}
            </Text>
          ) : null}
        </View>
        <View style={styles.line}>
          {p.arrow ? (
            <Text style={[styles.arrow, { color: p.arrowColor }, p.bold && styles.bold]} testID="conversation-arrow">
              {p.arrow}
            </Text>
          ) : null}
          {p.failed ? (
            <View style={styles.retry} testID="conversation-retry-icon">
              <Icon name="refresh" size={16} color={statusColors.failed} />
            </View>
          ) : null}
          <Text
            style={[styles.preview, p.bold && styles.bold, !p.preview && styles.noPreview]}
            numberOfLines={1}
            testID="conversation-preview"
          >
            {p.preview ?? 'No messages yet'}
          </Text>
        </View>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 75,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.md,
    backgroundColor: colors.white,
  },
  pressed: { backgroundColor: colors.surface },
  content: { flex: 1, gap: 2 },
  line: { flexDirection: 'row', alignItems: 'center' },
  username: { flex: 1, fontSize: 16, color: colors.text },
  bold: { fontWeight: '700' },
  time: { fontSize: 12, color: colors.textMuted, marginLeft: spacing.sm },
  arrow: { fontSize: 20, width: 24, lineHeight: 22 },
  retry: { marginRight: spacing.xs },
  preview: { flex: 1, fontSize: 15, color: colors.textMuted },
  noPreview: { fontStyle: 'italic' },
});
