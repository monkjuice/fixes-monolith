import { useCallback, useMemo, useState } from 'react';
import { RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '../../../core/api/errors';
import type { FriendRequest, User } from '../../../core/api/types';
import { relativeTime } from '../../../core/utils/relativeTime';
import { useFixes } from '../../../hooks';
import { Button, EmptyState, ErrorState, InlineError, LoadingState, UserRow, useToast } from '../../components';
import { useApiQuery } from '../../hooks/useApiQuery';
import { useFriendRequestCount } from '../../hooks/useFriendRequestCount';
import { useNow } from '../../hooks/useNow';
import { useReloadOnFocus } from '../../hooks/useReloadOnFocus';
import type { RootScreenProps } from '../../navigation/types';
import { describeError } from '../../presentation/errors';
import { colors, spacing, typography } from '../../theme';

type Direction = 'incoming' | 'outgoing';
type Action = 'accept' | 'decline' | 'cancel';

interface Section {
  key: Direction;
  title: string;
  data: FriendRequest[];
}

const keyExtractor = (request: FriendRequest) => request.id;

function sentAgo(request: FriendRequest, now: number): string {
  const created = Date.parse(request.created_at);
  return Number.isNaN(created) ? '' : relativeTime(created, { now: () => now });
}

/**
 * §14 Friend requests: incoming ones can be accepted or declined, outgoing ones cancelled. Tapping a
 * person opens their profile. The Profile tab badge follows the incoming count.
 */
export function FriendRequestsScreen({ navigation }: RootScreenProps<'FriendRequests'>) {
  const { session } = useFixes();
  const badge = useFriendRequestCount();
  const showToast = useToast();
  const now = useNow(60_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pulled, setPulled] = useState(false);

  const report = badge.report;
  const load = useCallback(async () => {
    const requests = await session.api.listFriendRequests();
    report(requests);
    return requests;
  }, [session, report]);
  const requests = useApiQuery(load);
  useReloadOnFocus(requests.reload);

  const sections = useMemo<Section[]>(() => {
    // No sections at all shows the list's empty state (which keeps pull to refresh).
    if (!requests.data || (requests.data.incoming.length === 0 && requests.data.outgoing.length === 0)) return [];
    return [
      { key: 'incoming', title: 'Received', data: requests.data.incoming },
      { key: 'outgoing', title: 'Sent', data: requests.data.outgoing },
    ];
  }, [requests.data]);

  const perform = async (request: FriendRequest, action: Action) => {
    if (busy) return;
    setBusy(request.id);
    setActionError(null);
    setPulled(false);
    try {
      if (action === 'accept') {
        await session.api.acceptFriendRequest(request.id);
        showToast(`You and ${request.from_user.username} are now friends.`);
      } else {
        await session.api.deleteFriendRequest(request.id);
      }
    } catch (error) {
      // not_found: the other side already cancelled (or accepted); the reload below shows that.
      if (!(error instanceof ApiError && error.code === 'not_found')) setActionError(describeError(error));
    } finally {
      setBusy(null);
      requests.reload();
      badge.refresh();
    }
  };

  const openProfile = useCallback(
    (user: User) => navigation.navigate('UserProfile', { userId: user.id, username: user.username }),
    [navigation],
  );

  const renderItem = ({ item, section }: { item: FriendRequest; section: Section }) => {
    const incoming = section.key === 'incoming';
    const other = incoming ? item.from_user : item.to_user;
    const working = busy === item.id;
    const ago = sentAgo(item, now);
    return (
      <UserRow
        user={other}
        onPress={openProfile}
        subtitle={ago ? `${incoming ? 'Received' : 'Sent'} ${ago}` : undefined}
        accessory={
          incoming ? (
            <>
              <Button
                title="Accept"
                onPress={() => void perform(item, 'accept')}
                busy={working}
                disabled={busy !== null}
                accessibilityLabel={`Accept ${other.username}`}
                style={styles.small}
                testID={`request-accept-${item.id}`}
              />
              <Button
                title="Decline"
                variant="secondary"
                onPress={() => void perform(item, 'decline')}
                disabled={busy !== null}
                accessibilityLabel={`Decline ${other.username}`}
                style={styles.small}
                testID={`request-decline-${item.id}`}
              />
            </>
          ) : (
            <Button
              title="Cancel"
              variant="secondary"
              onPress={() => void perform(item, 'cancel')}
              busy={working}
              disabled={busy !== null}
              accessibilityLabel={`Cancel the request to ${other.username}`}
              style={styles.small}
              testID={`request-cancel-${item.id}`}
            />
          )
        }
      />
    );
  };

  if (!requests.data) {
    return (
      <View style={styles.page}>
        {requests.error ? (
          <ErrorState message={describeError(requests.error)} onRetry={requests.reload} />
        ) : (
          <LoadingState label="Loading friend requests" />
        )}
      </View>
    );
  }

  return (
    <View style={styles.page}>
      <InlineError message={actionError} testID="friend-requests-error" />
      {requests.error ? <InlineError message={describeError(requests.error)} /> : null}
      <SectionList
        sections={sections}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        ListEmptyComponent={
          <EmptyState
            icon="people-outline"
            title="No friend requests"
            message="Find people in Discover and send them a request. Requests sent to you appear here."
            action={{ title: 'Go to Discover', onPress: () => navigation.navigate('Main', { screen: 'Discover' }) }}
            testID="friend-requests-empty"
          />
        }
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionHeader} accessibilityRole="header">
            {`${section.title} (${section.data.length})`}
          </Text>
        )}
        renderSectionFooter={({ section }) =>
          section.data.length === 0 ? (
            <Text style={styles.none}>{section.key === 'incoming' ? 'No requests waiting for you.' : 'No requests sent.'}</Text>
          ) : null
        }
        stickySectionHeadersEnabled={false}
        refreshControl={
          <RefreshControl
            refreshing={pulled && requests.loading}
            onRefresh={() => {
              setPulled(true);
              requests.reload();
            }}
            colors={[colors.black]}
            tintColor={colors.black}
          />
        }
        testID="friend-requests-list"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.white },
  sectionHeader: {
    ...typography.caption,
    fontWeight: '700',
    textTransform: 'uppercase',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
    backgroundColor: colors.white,
  },
  none: { ...typography.body, color: colors.textMuted, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  small: { paddingHorizontal: spacing.sm },
});
