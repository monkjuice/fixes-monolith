import { StyleSheet, Text, View } from 'react-native';

import { Button, confirm } from '../../components';
import type { Friendship } from '../../presentation/friendship';
import { spacing, typography } from '../../theme';

export type FriendshipAction =
  | { type: 'add' }
  | { type: 'accept'; requestId: string }
  | { type: 'decline'; requestId: string }
  | { type: 'cancel'; requestId: string }
  | { type: 'unfriend' };

export interface FriendshipActionsProps {
  friendship: Exclude<Friendship, { kind: 'self' }>;
  username: string;
  busy: boolean;
  onAction(action: FriendshipAction): void;
  onMessage(): void;
}

/**
 * The §14 friendship button in its four states, plus "Message" for friends. Undoing something the
 * other person sees (cancel a request, unfriend) asks first.
 */
export function FriendshipActions({ friendship, username, busy, onAction, onMessage }: FriendshipActionsProps) {
  switch (friendship.kind) {
    case 'none':
      return <Button title="Add friend" onPress={() => onAction({ type: 'add' })} busy={busy} testID="friendship-add" />;

    case 'requestSent': {
      const cancel = async () => {
        const confirmed = await confirm({
          title: 'Cancel friend request?',
          message: `${username} will no longer see your request.`,
          confirmText: 'Cancel request',
          cancelText: 'Keep',
          destructive: true,
        });
        if (confirmed) onAction({ type: 'cancel', requestId: friendship.requestId });
      };
      return (
        <Button
          title="Request sent"
          variant="secondary"
          accessibilityHint="Cancels the friend request"
          onPress={() => void cancel()}
          busy={busy}
          testID="friendship-sent"
        />
      );
    }

    case 'requestReceived':
      return (
        <View style={styles.block}>
          <Text style={styles.note}>{`${username} sent you a friend request.`}</Text>
          <View style={styles.row}>
            <Button
              title="Accept request"
              onPress={() => onAction({ type: 'accept', requestId: friendship.requestId })}
              busy={busy}
              style={styles.flex}
              testID="friendship-accept"
            />
            <Button
              title="Decline"
              variant="secondary"
              onPress={() => onAction({ type: 'decline', requestId: friendship.requestId })}
              busy={busy}
              style={styles.flex}
              testID="friendship-decline"
            />
          </View>
        </View>
      );

    case 'friends': {
      const unfriend = async () => {
        const confirmed = await confirm({
          title: `Remove ${username} from your friends?`,
          message: 'You will not be able to message each other until one of you sends a new friend request. Your conversation stays on this phone.',
          confirmText: 'Remove friend',
          destructive: true,
        });
        if (confirmed) onAction({ type: 'unfriend' });
      };
      return (
        <View style={styles.row}>
          <Button
            title="Friends"
            variant="secondary"
            accessibilityHint="Removes this friend"
            onPress={() => void unfriend()}
            busy={busy}
            style={styles.flex}
            testID="friendship-friends"
          />
          <Button title="Message" onPress={onMessage} disabled={busy} style={styles.flex} testID="friendship-message" />
        </View>
      );
    }
  }
}

const styles = StyleSheet.create({
  block: { gap: spacing.sm },
  row: { flexDirection: 'row', gap: spacing.md },
  flex: { flex: 1, paddingHorizontal: spacing.sm },
  note: { ...typography.body, textAlign: 'center' },
});
