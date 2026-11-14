import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '../../../core/api/errors';
import type { FriendRequestsResponse, User } from '../../../core/api/types';
import { useFixes, useSession } from '../../../hooks';
import { Avatar, Button, ErrorState, InlineError, ListItem, LoadingState, useToast } from '../../components';
import { useApiQuery } from '../../hooks/useApiQuery';
import { useFriendRequestCount } from '../../hooks/useFriendRequestCount';
import { useReloadOnFocus } from '../../hooks/useReloadOnFocus';
import type { RootScreenProps } from '../../navigation/types';
import { describeError } from '../../presentation/errors';
import { friendshipLabel, friendshipWith } from '../../presentation/friendship';
import { colors, spacing, typography } from '../../theme';
import { FriendshipActions, type FriendshipAction } from './FriendshipActions';

interface ProfileData {
  user: User;
  friends: User[];
  requests: FriendRequestsResponse;
}

/** Answers that only mean the screen is out of date: reload instead of showing an error. */
const STALE_CODES = new Set(['already_friends', 'request_exists', 'not_found']);

/**
 * Legacy ProfilePage for another user (§14): avatar and username, then "Add friend" / "Request sent"
 * / "Accept request" / "Friends", "Message" only for friends (§1: messaging requires friendship) and
 * "Security" (safety code).
 */
export function UserProfileScreen({ navigation, route }: RootScreenProps<'UserProfile'>) {
  const { userId, username } = route.params;
  const { session } = useFixes();
  const me = useSession().user?.id ?? '';
  const showToast = useToast();
  const badge = useFriendRequestCount();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Only a pull shows the refresh spinner; reloads after an action happen quietly.
  const [pulled, setPulled] = useState(false);

  const report = badge.report;
  const load = useCallback(async (): Promise<ProfileData> => {
    const [user, friends, requests] = await Promise.all([
      session.api.getUser(userId),
      session.api.listFriends(),
      session.api.listFriendRequests(),
    ]);
    report(requests);
    return { user, friends: friends.friends, requests };
  }, [session, userId, report]);
  const profile = useApiQuery(load);
  useReloadOnFocus(profile.reload);

  const data = profile.data;
  const title = data?.user.username ?? username ?? 'Profile';
  const friendship = useMemo(() => (data ? friendshipWith(me, userId, data.friends, data.requests) : null), [data, me, userId]);

  useLayoutEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);

  const perform = async (action: FriendshipAction) => {
    if (busy || !data) return;
    setBusy(true);
    setActionError(null);
    setPulled(false);
    try {
      if (action.type === 'add') {
        const result = await session.api.createFriendRequest(userId);
        // §5.3: the other user had already asked me, so the request became a friendship at once.
        if (result.status === 'accepted') showToast(`You and ${data.user.username} are now friends.`);
      } else if (action.type === 'accept') {
        await session.api.acceptFriendRequest(action.requestId);
        showToast(`You and ${data.user.username} are now friends.`);
      } else if (action.type === 'decline' || action.type === 'cancel') {
        await session.api.deleteFriendRequest(action.requestId);
      } else {
        await session.api.removeFriend(userId);
      }
    } catch (error) {
      if (!(error instanceof ApiError && STALE_CODES.has(error.code))) {
        setActionError(describeError(error, { cannot_friend_self: 'You cannot add yourself as a friend.' }));
      }
    } finally {
      setBusy(false);
      profile.reload();
      badge.refresh();
    }
  };

  /**
   * "Message": when this profile was opened from that very conversation, go back to it instead of
   * stacking a second copy (React Navigation 7's navigate always pushes a new screen).
   */
  const openConversation = (user: User) => {
    const params = { peerUserId: user.id, peerUsername: user.username, profile: user };
    const conversations = navigation.getState().routes.filter((route) => route.name === 'Conversation');
    const last = conversations[conversations.length - 1];
    const lastPeer = (last?.params as { peerUserId?: string } | undefined)?.peerUserId;
    if (lastPeer === user.id) navigation.popTo('Conversation', params);
    else navigation.navigate('Conversation', params);
  };

  // A 404 also after a reload (the account was deleted meanwhile) replaces the profile shown so far.
  const gone = profile.error instanceof ApiError && profile.error.code === 'not_found';
  if (gone) {
    return (
      <View style={styles.page}>
        <ErrorState message="This user no longer exists." testID="user-profile-error" />
      </View>
    );
  }
  if (!data) {
    return (
      <View style={styles.page}>
        {profile.error ? (
          <ErrorState message={describeError(profile.error)} onRetry={profile.reload} testID="user-profile-error" />
        ) : (
          <LoadingState label="Loading profile" />
        )}
      </View>
    );
  }

  const user = data.user;
  const status = friendship ? friendshipLabel(friendship) : null;
  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={pulled && profile.loading}
          onRefresh={() => {
            setPulled(true);
            profile.reload();
          }}
          colors={[colors.black]}
          tintColor={colors.black}
        />
      }
    >
      <View style={styles.header}>
        <Avatar uri={user.avatar_url} size={90} />
        <Text style={styles.username} accessibilityRole="header" testID="user-profile-name">
          {user.username}
        </Text>
        {status ? (
          <Text style={styles.status} testID="user-profile-status">
            {status}
          </Text>
        ) : null}
      </View>

      {friendship?.kind === 'self' ? (
        <Button title="Edit profile" variant="secondary" onPress={() => navigation.navigate('EditProfile')} />
      ) : friendship ? (
        <FriendshipActions
          friendship={friendship}
          username={user.username}
          busy={busy}
          onAction={(action) => void perform(action)}
          onMessage={() => openConversation(user)}
        />
      ) : null}
      <InlineError message={actionError} testID="user-profile-action-error" />
      {profile.error ? <InlineError message={describeError(profile.error)} /> : null}

      {friendship?.kind !== 'self' ? (
        <View style={styles.section}>
          <ListItem
            icon="shield-checkmark-outline"
            title="Security"
            subtitle="Safety code and verification"
            onPress={() => navigation.navigate('Security', { userId: user.id, username: user.username })}
            testID="user-profile-security"
          />
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.white },
  content: { padding: spacing.xl, gap: spacing.md },
  header: { alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  username: { ...typography.title },
  status: { ...typography.caption, fontSize: 14 },
  section: { marginTop: spacing.lg, marginHorizontal: -spacing.xl, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
});
