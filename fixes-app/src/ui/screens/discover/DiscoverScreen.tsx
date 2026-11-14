import { useCallback, useRef, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';

import type { User } from '../../../core/api/types';
import { useFixes, useSession } from '../../../hooks';
import { EmptyState, ErrorState, InlineError, LoadingState, SearchBar, UserRow } from '../../components';
import type { TabScreenProps } from '../../navigation/types';
import { describeError } from '../../presentation/errors';
import { validateSearchInput } from '../../presentation/search';
import { colors, spacing } from '../../theme';

type SearchState =
  | { status: 'loading'; query: string; users: readonly User[] }
  | { status: 'done'; query: string; users: readonly User[] }
  | { status: 'error'; query: string; users: readonly User[]; error: unknown };

const keyExtractor = (user: User) => user.id;

/**
 * Legacy Discover → Search users (§14): submit to search, results open the profile. The query is
 * checked against `[A-Za-z0-9_]{1,30}` before calling the server; the server excludes the caller and
 * returns at most 20 users.
 */
export function DiscoverScreen({ navigation }: TabScreenProps<'Discover'>) {
  const { session } = useFixes();
  const me = useSession().user?.id ?? null;
  const [text, setText] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [search, setSearch] = useState<SearchState | null>(null);
  // Only the newest search may show its answer (an older, slower one must not overwrite it).
  const latest = useRef(0);

  const run = useCallback(
    async (query: string) => {
      const id = ++latest.current;
      setSearch((previous) => ({ status: 'loading', query, users: previous?.users ?? [] }));
      try {
        const { users } = await session.api.searchUsers(query);
        // The server already leaves the caller out (§5.3); this keeps "me" out even if it did not.
        if (latest.current === id) setSearch({ status: 'done', query, users: users.filter((user) => user.id !== me) });
      } catch (error) {
        if (latest.current === id) setSearch((previous) => ({ status: 'error', query, users: previous?.users ?? [], error }));
      }
    },
    [session, me],
  );

  const submit = () => {
    const input = validateSearchInput(text);
    if (!input.ok) {
      setInputError(input.error);
      return;
    }
    setInputError(null);
    void run(input.query);
  };

  const changeText = (value: string) => {
    setText(value);
    if (value.length === 0) {
      // Clearing the field returns to the start page; a search still running is ignored.
      latest.current++;
      setSearch(null);
      setInputError(null);
    }
  };

  const openProfile = useCallback(
    (user: User) => navigation.navigate('UserProfile', { userId: user.id, username: user.username }),
    [navigation],
  );
  const renderItem = useCallback(({ item }: { item: User }) => <UserRow user={item} onPress={openProfile} />, [openProfile]);

  let empty;
  if (search === null) {
    empty = (
      <EmptyState
        icon="people-outline"
        title="Find people"
        message="Search by username, then open a profile to send a friend request."
        testID="discover-start"
      />
    );
  } else if (search.status === 'loading') {
    empty = <LoadingState label="Searching" />;
  } else if (search.status === 'error') {
    empty = <ErrorState message={describeError(search.error)} onRetry={() => void run(search.query)} testID="discover-error" />;
  } else {
    empty = <EmptyState icon="search-outline" title="No users found" message={`No username contains "${search.query}".`} testID="discover-empty" />;
  }

  return (
    <View style={styles.page}>
      <SearchBar value={text} onChangeText={changeText} onSubmit={submit} maxLength={30} testID="discover-search" />
      <InlineError message={inputError} testID="discover-input-error" />
      {search?.status === 'error' && search.users.length > 0 ? <InlineError message={describeError(search.error)} /> : null}
      <FlatList
        data={search?.users ?? []}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        ItemSeparatorComponent={Separator}
        ListEmptyComponent={empty}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        testID="discover-results"
      />
    </View>
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.white },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: 55 + 2 * spacing.md },
});
