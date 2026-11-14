import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import type { User } from '../../../core/api/types';
import { useFixes } from '../../../hooks';
import { Button, EmptyState, SearchBar, UserRow } from '../../components';
import { useApiQuery } from '../../hooks/useApiQuery';
import type { RootScreenProps } from '../../navigation/types';
import { describeError } from '../../presentation/errors';
import { colors, spacing, typography } from '../../theme';

const keyExtractor = (user: User) => user.id;

/**
 * Legacy NewConversationPage (§14): the friends list with a local search filter. Messaging requires
 * friendship (§1), so only friends are offered. The conversation row is created by the first message
 * (the friend's profile goes along), so opening and leaving leaves no empty conversation behind.
 */
export function NewConversationScreen({ navigation }: RootScreenProps<'NewConversation'>) {
  const { session } = useFixes();
  const loadFriends = useCallback(async () => (await session.api.listFriends()).friends, [session]);
  const friends = useApiQuery(loadFriends);
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = friends.data ?? [];
    return needle ? all.filter((user) => user.username.toLowerCase().includes(needle)) : all;
  }, [friends.data, query]);

  const open = useCallback(
    (user: User) => navigation.replace('Conversation', { peerUserId: user.id, peerUsername: user.username, profile: user }),
    [navigation],
  );

  const renderItem = useCallback(({ item }: { item: User }) => <UserRow user={item} onPress={open} />, [open]);

  let empty;
  if (friends.loading && friends.data === null) {
    empty = <ActivityIndicator style={styles.loading} color={colors.black} accessibilityLabel="Loading friends" />;
  } else if (friends.error && friends.data === null) {
    empty = (
      <View style={styles.errorBox}>
        <Text style={styles.error} accessibilityRole="alert">
          {describeError(friends.error)}
        </Text>
        <Button title="Retry" variant="secondary" onPress={friends.reload} />
      </View>
    );
  } else if (query.trim().length > 0) {
    empty = <EmptyState icon="search-outline" title="No friends match your search" />;
  } else {
    empty = (
      <EmptyState
        icon="people-outline"
        title="No friends yet"
        message="You can message people once they accept your friend request. Find them in Discover."
        action={{ title: 'Go to Discover', onPress: () => navigation.navigate('Main', { screen: 'Discover' }) }}
      />
    );
  }

  return (
    <View style={styles.page}>
      <SearchBar value={query} onChangeText={setQuery} maxLength={30} testID="friends-search" />
      {friends.error && friends.data !== null ? (
        <Text style={styles.inlineError} accessibilityRole="alert">
          {describeError(friends.error)}
        </Text>
      ) : null}
      <FlatList
        data={visible}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        ListEmptyComponent={empty}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={friends.loading && friends.data !== null}
            onRefresh={friends.reload}
            colors={[colors.black]}
            tintColor={colors.black}
          />
        }
        testID="friends-list"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.white },
  loading: { marginTop: spacing.xxl },
  errorBox: { alignItems: 'center', gap: spacing.md, padding: spacing.xl },
  error: { ...typography.body, color: colors.danger, textAlign: 'center' },
  inlineError: { ...typography.body, color: colors.danger, textAlign: 'center', padding: spacing.sm },
});
