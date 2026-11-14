import { useCallback, useLayoutEffect } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { useFixes, useSession } from '../../../hooks';
import { Avatar, Button, IconButton, InlineError, ListItem } from '../../components';
import { useApiQuery } from '../../hooks/useApiQuery';
import { useFriendRequestCount } from '../../hooks/useFriendRequestCount';
import { useLogout } from '../../hooks/useLogout';
import { useReloadOnFocus } from '../../hooks/useReloadOnFocus';
import type { TabScreenProps } from '../../navigation/types';
import { reportBackgroundError } from '../../presentation/errors';
import { colors, spacing, typography } from '../../theme';

/**
 * Legacy ProfilePage (me): avatar, username, Log Out, Edit (§14), plus Friend requests and Settings.
 * The account is fetched again on focus, so a new avatar (from Edit profile here or from another
 * device) shows up; the session's copy is used until then and when offline.
 */
export function ProfileScreen({ navigation }: TabScreenProps<'Profile'>) {
  const { session } = useFixes();
  const { user } = useSession();
  const { logout, busy, error } = useLogout();
  const friendRequests = useFriendRequestCount();

  const loadMe = useCallback(async () => {
    try {
      return await session.api.getMe();
    } catch (caught) {
      reportBackgroundError('Refreshing my profile', caught);
      throw caught;
    }
  }, [session]);
  const me = useApiQuery(loadMe);
  const refreshCount = friendRequests.refresh;
  const reloadMe = me.reload;
  const reload = useCallback(() => {
    reloadMe();
    refreshCount();
  }, [reloadMe, refreshCount]);
  useReloadOnFocus(reload);
  const shown = me.data ?? user;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <IconButton
          icon="create-outline"
          accessibilityLabel="Edit profile"
          color={colors.white}
          onPress={() => navigation.navigate('EditProfile')}
          testID="profile-edit"
        />
      ),
    });
  }, [navigation]);

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Avatar uri={shown?.avatar_url} size={90} testID="profile-avatar" />
        <Text style={styles.username} accessibilityRole="header">
          {shown?.username ?? ''}
        </Text>
      </View>
      <View style={styles.list}>
        <ListItem
          icon="people-outline"
          title="Friend requests"
          badge={friendRequests.incoming}
          onPress={() => navigation.navigate('FriendRequests')}
          testID="profile-friend-requests"
        />
        <ListItem icon="settings-outline" title="Settings" onPress={() => navigation.navigate('Settings')} testID="profile-settings" />
      </View>
      <Button title={busy ? 'Logging out..' : 'Log Out'} variant="link" onPress={logout} busy={busy} testID="profile-logout" />
      <InlineError message={error} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.white },
  content: { paddingVertical: spacing.xl, gap: spacing.md },
  header: { alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  username: { ...typography.title },
  list: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
});
