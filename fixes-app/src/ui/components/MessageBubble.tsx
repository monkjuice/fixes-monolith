import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { MessageRow } from '../../core/db/types';
import { outgoingStatus } from '../presentation/messageStatus';
import { colors, spacing, statusColors } from '../theme';
import { Icon } from './Icon';

export interface MessageBubbleProps {
  message: MessageRow;
  /** Tap on a failed message of mine (§14 "tap failed message to retry"). */
  onRetry(messageId: string): void;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Legacy MessageBubble: mine on the right, theirs on the left; system notices centred. Status ticks
 * (§14 colours) sit under my bubbles on the white page, where every status colour stays visible.
 */
export const MessageBubble = memo(function MessageBubble({ message, onRetry }: MessageBubbleProps) {
  if (message.direction === 'system') {
    return (
      <View style={styles.systemRow} testID={`message-${message.id}`}>
        <Text style={styles.systemText} accessibilityRole="text">
          {message.body}
        </Text>
      </View>
    );
  }

  const mine = message.direction === 'out';
  const status = mine ? outgoingStatus(message.status) : null;
  const failed = mine && message.status === 'failed';
  const time = formatTime(message.sort_ts);
  const label = `${mine ? 'You' : 'Them'}: ${message.body}. ${time}${status ? `. ${status.label}` : ''}`;

  const bubble = (
    <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
      <Text style={mine ? styles.mineText : styles.theirsText} selectable>
        {message.body}
      </Text>
    </View>
  );

  return (
    <View style={[styles.row, mine ? styles.rowMine : styles.rowTheirs]} testID={`message-${message.id}`}>
      {failed ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint="Tries to send the message again"
          onPress={() => onRetry(message.id)}
          testID={`retry-${message.id}`}
        >
          {bubble}
        </Pressable>
      ) : (
        <View accessible accessibilityLabel={label}>
          {bubble}
        </View>
      )}
      <View style={[styles.meta, mine ? styles.metaMine : null]} importantForAccessibility="no-hide-descendants">
        <Text style={styles.time}>{time}</Text>
        {status?.icon ? (
          <View testID={`status-${message.id}`} accessibilityLabel={status.label}>
            <Icon name={status.icon} size={14} color={status.color} />
          </View>
        ) : null}
      </View>
      {failed ? <Text style={styles.failedText}>Not sent. Tap to retry.</Text> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  row: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, maxWidth: '100%' },
  rowMine: { alignItems: 'flex-end' },
  rowTheirs: { alignItems: 'flex-start' },
  bubble: { maxWidth: '80%', borderRadius: 5, paddingHorizontal: spacing.sm + 2, paddingVertical: spacing.sm, borderWidth: 1 },
  mine: { backgroundColor: colors.black, borderColor: colors.black },
  theirs: { backgroundColor: colors.white, borderColor: colors.textMuted },
  mineText: { color: colors.white, fontSize: 15 },
  theirsText: { color: colors.text, fontSize: 15 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  metaMine: { justifyContent: 'flex-end' },
  time: { fontSize: 11, color: colors.textMuted },
  failedText: { fontSize: 12, color: statusColors.failed, marginTop: 2 },
  systemRow: { alignItems: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.sm },
  systemText: { fontSize: 13, color: colors.textMuted, fontStyle: 'italic', textAlign: 'center' },
});
