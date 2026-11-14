import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { CompositeScreenProps, NavigatorScreenParams } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';

import type { User } from '../../core/api/types';

export type MainTabParamList = {
  Messages: undefined;
  Discover: undefined;
  Profile: undefined;
};

/**
 * Every screen lives in one root stack whose screens depend on the session status (§9 step 1):
 * loading → Splash; signedOut → Login/Register; needsLink → NeedsLink; ready → Main (tabs) plus the
 * stack screens pushed over the tabs.
 */
export type RootStackParamList = {
  Splash: undefined;
  Login: undefined;
  Register: undefined;
  NeedsLink: undefined;
  Main: NavigatorScreenParams<MainTabParamList> | undefined;
  /** `profile` comes from the friends list for a conversation that may not exist yet. */
  Conversation: { peerUserId: string; peerUsername?: string; profile?: User };
  NewConversation: undefined;
  UserProfile: { userId: string; username?: string };
  EditProfile: undefined;
  FriendRequests: undefined;
  Settings: undefined;
  Devices: undefined;
  LinkDevice: undefined;
  /** An already linked device shows a link code to receive its history again (§13 gap). */
  ReceiveHistory: undefined;
  Backup: undefined;
  /** Safety code of a contact (§4.4). */
  Security: { userId: string; username?: string };
  ChangePassword: undefined;
};

export type RootScreenProps<Name extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, Name>;

export type TabScreenProps<Name extends keyof MainTabParamList> = CompositeScreenProps<
  BottomTabScreenProps<MainTabParamList, Name>,
  NativeStackScreenProps<RootStackParamList>
>;

export type RootNavigation = NativeStackNavigationProp<RootStackParamList>;
