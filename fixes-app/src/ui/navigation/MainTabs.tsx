import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import { Icon, type IconName } from '../components';
import { useFriendRequestCount } from '../hooks/useFriendRequestCount';
import { InboxScreen } from '../screens/inbox/InboxScreen';
import { DiscoverScreen } from '../screens/discover/DiscoverScreen';
import { ProfileScreen } from '../screens/profile/ProfileScreen';
import { colors, headerOptions } from '../theme';
import type { MainTabParamList } from './types';

const Tab = createBottomTabNavigator<MainTabParamList>();

const TAB_ICONS: Record<keyof MainTabParamList, IconName> = {
  Messages: 'mail',
  Discover: 'search',
  Profile: 'person',
};

/** §14 tabs: Messages, Discover, Profile on a black bar (white selected, 40 % white unselected). */
export function MainTabs() {
  const { incoming } = useFriendRequestCount();
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        ...headerOptions,
        tabBarStyle: { backgroundColor: colors.black, borderTopColor: colors.black },
        tabBarActiveTintColor: colors.tabActive,
        tabBarInactiveTintColor: colors.tabInactive,
        tabBarIcon: ({ color, size }) => <Icon name={TAB_ICONS[route.name]} color={color} size={size} />,
      })}
    >
      <Tab.Screen name="Messages" component={InboxScreen} />
      <Tab.Screen name="Discover" component={DiscoverScreen} />
      <Tab.Screen
        name="Profile"
        component={ProfileScreen}
        options={{
          // Incoming friend requests wait behind Profile → Friend requests.
          tabBarBadge: incoming > 0 ? (incoming > 99 ? '99+' : incoming) : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.danger, color: colors.white },
        }}
      />
    </Tab.Navigator>
  );
}
