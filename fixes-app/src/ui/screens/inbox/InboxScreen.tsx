import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import type { InboxRow } from '../../../core/db/types';
import { useConversations, useFixes } from '../../../hooks';
import { Button, ConversationRow, EmptyState, FAB, SearchBar } from '../../components';
import { useNow } from '../../hooks/useNow';
import type { TabScreenProps } from '../../navigation/types';
import { filterByUsername } from '../../presentation/inbox';
import { reportBackgroundError } from '../../presentation/errors';
import { colors, spacing, typography } from '../../theme';
import { InboxBanners } from './InboxBanners';

/** Relative times ("x seconds ago") are re-rendered this often. */
const CLOCK_TICK_MS = 15_000;

const keyExtractor = (row: InboxRow) => row.peer_user_id;

/**
 * Legacy InboxPage (§14): search bar (local username filter), conversations sorted by last activity,
 * black FAB → New conversation. Peer names/avatars are refreshed when the inbox gains focus (§13; the
 * engine limits it to once a minute). Pull to refresh drains the mailbox.
 */
export function InboxScreen({ navigation }: TabScreenProps<'Messages'>) {
  const { messaging } = useFixes();
  const inbox = useConversations();
  const now = useNow(CLOCK_TICK_MS);
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const rows = useMemo(() => filterByUsername(inbox.data, query), [inbox.data, query]);

  useFocusEffect(
    useCallback(() => {
      messaging.refreshPeers().catch((error: unknown) => reportBackgroundError('Refreshing peer profiles', error));
    }, [messaging]),
  );

  const openConversation = useCallback(
    (row: InboxRow) => navigation.navigate('Conversation', { peerUserId: row.peer_user_id, peerUsername: row.peer_username }),
    [navigation],
  );

  const refresh = () => {
    setRefreshing(true);
    void Promise.allSettled([messaging.syncNow(), messaging.refreshPeers({ force: true })])
      .then((results) => {
        for (const result of results) {
          if (result.status === 'rejected') reportBackgroundError('Refreshing the inbox', result.reason);
        }
      })
      .finally(() => setRefreshing(false));
  };

  const renderItem = useCallback(
    ({ item }: { item: InboxRow }) => <ConversationRow row={item} now={now} onPress={openConversation} />,
    [now, openConversation],
  );

  let empty;
  if (inbox.loading) {
    empty = <ActivityIndicator style={styles.loading} color={colors.black} accessibilityLabel="Loading conversations" />;
  } else if (inbox.error) {
    empty = (
      <View style={styles.errorBox}>
        <Text style={styles.error} accessibilityRole="alert">
          Your conversations could not be loaded.
        </Text>
        <Button title="Retry" variant="secondary" onPress={inbox.reload} />
      </View>
    );
  } else if (query.trim().length > 0) {
    empty = <EmptyState icon="search-outline" title="No conversations match your search" />;
  } else {
    empty = (
      <EmptyState
        icon="chatbubbles-outline"
        title="No conversations yet"
        message="Tap the button below to send a message to a friend."
        testID="inbox-empty"
      />
    );
  }

  return (
    <View style={styles.page}>
      <SearchBar value={query} onChangeText={setQuery} maxLength={30} testID="inbox-search" />
      <InboxBanners />
      <FlatList
        data={rows}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        ItemSeparatorComponent={Separator}
        ListEmptyComponent={empty}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} colors={[colors.black]} tintColor={colors.black} />}
        testID="inbox-list"
      />
      <FAB icon="chatbubble-ellipses" accessibilityLabel="New conversation" onPress={() => navigation.navigate('NewConversation')} testID="inbox-fab" />
    </View>
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.white },
  // Room for the FAB so it never covers the last row.
  list: { paddingBottom: 100 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: 55 + 2 * spacing.md },
  loading: { marginTop: spacing.xxl },
  errorBox: { alignItems: 'center', gap: spacing.md, padding: spacing.xl },
  error: { ...typography.body, color: colors.danger, textAlign: 'center' },
});
