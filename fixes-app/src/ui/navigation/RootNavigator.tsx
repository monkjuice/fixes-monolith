import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';

import { useSession } from '../../hooks';
import { LoginScreen } from '../screens/auth/LoginScreen';
import { RegisterScreen } from '../screens/auth/RegisterScreen';
import { ConversationScreen } from '../screens/conversation/ConversationScreen';
import { NewConversationScreen } from '../screens/conversation/NewConversationScreen';
import { FriendRequestsScreen } from '../screens/friends/FriendRequestsScreen';
import { NeedsLinkScreen } from '../screens/link/NeedsLinkScreen';
import { EditProfileScreen } from '../screens/profile/EditProfileScreen';
import { SecurityScreen } from '../screens/profile/SecurityScreen';
import { UserProfileScreen } from '../screens/profile/UserProfileScreen';
import { BackupScreen } from '../screens/settings/BackupScreen';
import { ChangePasswordScreen } from '../screens/settings/ChangePasswordScreen';
import { DevicesScreen } from '../screens/settings/DevicesScreen';
import { LinkDeviceScreen } from '../screens/settings/LinkDeviceScreen';
import { ReceiveHistoryScreen } from '../screens/settings/ReceiveHistoryScreen';
import { SettingsScreen } from '../screens/settings/SettingsScreen';
import { SplashScreen } from '../screens/SplashScreen';
import { colors, headerOptions } from '../theme';
import { MainTabs } from './MainTabs';
import type { RootStackParamList } from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * The root switch: the screens that exist depend on the session status, so a status change (login,
 * linking done, revocation, logout) replaces the whole stack and nothing from the previous state can
 * be navigated back to. Must be rendered inside FixesProvider and a NavigationContainer.
 */
export function RootNavigator() {
  const { status } = useSession();
  // White auth/splash pages need dark status bar text; the black headers need light text.
  const darkStatusBar = status === 'loading' || status === 'signedOut';
  return (
    <>
      <StatusBar style={darkStatusBar ? 'dark' : 'light'} />
      <Stack.Navigator
        screenOptions={{ ...headerOptions, headerBackButtonDisplayMode: 'minimal', contentStyle: { backgroundColor: colors.white } }}
      >
        {status === 'loading' ? (
          <Stack.Screen name="Splash" component={SplashScreen} options={{ headerShown: false }} />
        ) : status === 'signedOut' ? (
          <Stack.Group screenOptions={{ headerShown: false }}>
            <Stack.Screen name="Login" component={LoginScreen} />
            <Stack.Screen name="Register" component={RegisterScreen} />
          </Stack.Group>
        ) : status === 'needsLink' ? (
          <Stack.Screen name="NeedsLink" component={NeedsLinkScreen} options={{ title: 'Link this device' }} />
        ) : (
          <Stack.Group>
            <Stack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />
            <Stack.Screen name="Conversation" component={ConversationScreen} options={{ title: '' }} />
            <Stack.Screen name="NewConversation" component={NewConversationScreen} options={{ title: 'New Conversation' }} />
            <Stack.Screen name="UserProfile" component={UserProfileScreen} options={{ title: 'Profile' }} />
            <Stack.Screen name="EditProfile" component={EditProfileScreen} options={{ title: 'Edit profile' }} />
            <Stack.Screen name="FriendRequests" component={FriendRequestsScreen} options={{ title: 'Friend requests' }} />
            <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
            <Stack.Screen name="Devices" component={DevicesScreen} options={{ title: 'Devices' }} />
            <Stack.Screen name="LinkDevice" component={LinkDeviceScreen} options={{ title: 'Link a new device' }} />
            <Stack.Screen name="ReceiveHistory" component={ReceiveHistoryScreen} options={{ title: 'Receive history' }} />
            <Stack.Screen name="Backup" component={BackupScreen} options={{ title: 'Backups' }} />
            <Stack.Screen name="Security" component={SecurityScreen} options={{ title: 'Security' }} />
            <Stack.Screen name="ChangePassword" component={ChangePasswordScreen} options={{ title: 'Change password' }} />
          </Stack.Group>
        )}
      </Stack.Navigator>
    </>
  );
}
