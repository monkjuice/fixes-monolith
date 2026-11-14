import type {
  CreateFriendRequestResponse,
  FriendRequestsResponse,
  Me,
  MyDevice,
  User,
} from '../../../core/api/types';
import type { IdentityKeyPair } from '../../../core/crypto/identity';
import { IDLE_INCOMING_TRANSFER, type IncomingTransferState } from '../../../core/linking/incoming';
import { IDLE_OUTGOING_LINK, type OutgoingLinkState } from '../../../core/linking/outgoing';
import type { LogoutOutcome, MessagingState } from '../../../core/messaging/engine';
import type { SessionState } from '../../../core/session/sessionManager';
import { StateCell } from '../../../core/utils/stateCell';
import type { FixesServices } from '../../../hooks';

/**
 * Hand-rolled stand-ins for SessionManager and MessagingEngine: observable state the test drives,
 * jest.fn actions the test inspects. For flows that need real data use createTestPhone instead.
 */

export const BASE_SESSION: SessionState = {
  status: 'loading',
  user: null,
  device: null,
  offline: false,
  error: null,
  signedOutReason: null,
  localDataReset: false,
};

export const TEST_USER = { id: '6f1c2a54-0a3b-4c5d-8e9f-1a2b3c4d5e6f', username: 'alice', avatar_url: null, identity_key: null };

export const TEST_QR = 'fixes-link:1:test-transfer:test-device:public-key:transfer-key';

export function createFakeServices(initial: Partial<SessionState> = {}) {
  const sessionState = new StateCell<SessionState>({ ...BASE_SESSION, ...initial });
  const messagingState = new StateCell<MessagingState>({ status: 'stopped', connection: 'idle', syncing: false, gap: false });
  const incomingLink = new StateCell<IncomingTransferState>(IDLE_INCOMING_TRANSFER);
  const outgoingLink = new StateCell<OutgoingLinkState>(IDLE_OUTGOING_LINK);

  const session = {
    getState: sessionState.get,
    subscribe: sessionState.subscribe,
    start: jest.fn(async (): Promise<void> => undefined),
    retry: jest.fn(async (): Promise<void> => undefined),
    login: jest.fn(async (_username: string, _password: string): Promise<void> => undefined),
    register: jest.fn(async (username: string, _password: string): Promise<User> => ({ id: TEST_USER.id, username, avatar_url: null })),
    resetIdentity: jest.fn(async (_password: string): Promise<void> => undefined),
    eraseDevice: jest.fn(async (): Promise<{ serverRevoked: boolean }> => ({ serverRevoked: true })),
    updateUser: jest.fn(async (_user: Me): Promise<void> => undefined),
    // This install's AIK (none unless a test provides one).
    getIdentity: jest.fn(async (): Promise<IdentityKeyPair | null> => null),
    // No database in these tests: the data hooks show their empty state.
    getLocalStore: () => null,
    // Every endpoint the screens call; tests override single answers with mockResolvedValueOnce etc.
    api: {
      getMe: jest.fn(async (): Promise<Me> => sessionState.get().user ?? TEST_USER),
      getUser: jest.fn(async (userId: string): Promise<User> => ({ id: userId, username: 'someone', avatar_url: null })),
      searchUsers: jest.fn(async (_q: string) => ({ users: [] as User[] })),
      listFriends: jest.fn(async () => ({ friends: [] as User[] })),
      removeFriend: jest.fn(async (_userId: string): Promise<void> => undefined),
      listFriendRequests: jest.fn(async (): Promise<FriendRequestsResponse> => ({ incoming: [], outgoing: [] })),
      createFriendRequest: jest.fn(async (_toUserId: string): Promise<CreateFriendRequestResponse> => {
        throw new Error('createFriendRequest: no answer configured');
      }),
      acceptFriendRequest: jest.fn(async (_requestId: string): Promise<{ friend: User }> => {
        throw new Error('acceptFriendRequest: no answer configured');
      }),
      deleteFriendRequest: jest.fn(async (_requestId: string): Promise<void> => undefined),
      listMyDevices: jest.fn(async () => ({ devices: [] as MyDevice[] })),
      revokeDevice: jest.fn(async (_deviceId: string): Promise<void> => undefined),
      changePassword: jest.fn(async (_current: string, _next: string): Promise<void> => undefined),
      uploadAvatar: jest.fn(async (_uri: string): Promise<{ user: Me }> => ({ user: sessionState.get().user ?? TEST_USER })),
    },
  };

  const messaging = {
    getState: messagingState.get,
    subscribe: messagingState.subscribe,
    incomingLink,
    outgoingLink,
    createLinkQr: jest.fn(async () => {
      incomingLink.set({ ...IDLE_INCOMING_TRANSFER, phase: 'waiting', transferId: 'test-transfer', qr: TEST_QR });
      return TEST_QR;
    }),
    cancelIncomingLink: jest.fn(async () => undefined),
    startLink: jest.fn(async () => undefined),
    resendLink: jest.fn(async () => undefined),
    cancelLink: jest.fn(),
    resetLink: jest.fn(),
    refreshPeers: jest.fn(async () => true),
    syncNow: jest.fn(async () => undefined),
    dismissGap: jest.fn(() => messagingState.update({ gap: false })),
    logout: jest.fn(async (): Promise<LogoutOutcome> => ({ status: 'loggedOut' })),
    acceptIdentityChange: jest.fn(async (_peer: string) => true),
    setContactVerified: jest.fn(async (_peer: string, _verified: boolean): Promise<void> => undefined),
  };

  const services = { session, messaging, backup: {} } as unknown as FixesServices;
  return {
    services,
    session,
    messaging,
    setSession: (patch: Partial<SessionState>) => sessionState.update(patch),
    setMessaging: (patch: Partial<MessagingState>) => messagingState.update(patch),
  };
}

export type FakeServices = ReturnType<typeof createFakeServices>;
