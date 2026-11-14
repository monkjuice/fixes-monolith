import { act, fireEvent, screen } from '@testing-library/react-native';
import { Alert, type AlertButton } from 'react-native';

import { ApiError } from '../../core/api/errors';
import type { FriendRequest, User } from '../../core/api/types';
import { UserProfileScreen } from '../screens/profile/UserProfileScreen';
import { createFakeServices, TEST_USER } from './support/fakeServices';
import { renderScreen } from './support/renderScreen';

const BOB: User = { id: '22222222-2222-4222-8222-222222222222', username: 'bob', avatar_url: null };
const ME: User = { id: TEST_USER.id, username: TEST_USER.username, avatar_url: null };

/** A tiny friendship model behind the fake API, so every reload sees the effect of the last action. */
function setUp(initial: 'none' | 'sent' | 'received' | 'friends') {
  const fake = createFakeServices({ status: 'ready', user: TEST_USER });
  const state = { friends: [] as User[], incoming: [] as FriendRequest[], outgoing: [] as FriendRequest[] };
  const sent: FriendRequest = { id: 'req-out', from_user: ME, to_user: BOB, created_at: '2026-01-01T00:00:00.000Z' };
  const received: FriendRequest = { id: 'req-in', from_user: BOB, to_user: ME, created_at: '2026-01-01T00:00:00.000Z' };
  if (initial === 'sent') state.outgoing = [sent];
  if (initial === 'received') state.incoming = [received];
  if (initial === 'friends') state.friends = [BOB];

  const api = fake.session.api;
  api.getUser.mockImplementation(async () => BOB);
  api.listFriends.mockImplementation(async () => ({ friends: [...state.friends] }));
  api.listFriendRequests.mockImplementation(async () => ({ incoming: [...state.incoming], outgoing: [...state.outgoing] }));
  api.createFriendRequest.mockImplementation(async () => {
    state.outgoing = [sent];
    return { status: 'pending', friend_request: sent };
  });
  api.acceptFriendRequest.mockImplementation(async () => {
    state.incoming = [];
    state.friends = [BOB];
    return { friend: BOB };
  });
  api.deleteFriendRequest.mockImplementation(async (id: string) => {
    state.incoming = state.incoming.filter((r) => r.id !== id);
    state.outgoing = state.outgoing.filter((r) => r.id !== id);
  });
  api.removeFriend.mockImplementation(async () => {
    state.friends = [];
  });
  renderScreen('UserProfile', UserProfileScreen, fake.services, { userId: BOB.id, username: 'bob' });
  return fake;
}

function lastAlert(alert: jest.SpyInstance) {
  const [title, message, buttons] = alert.mock.calls[alert.mock.calls.length - 1] as [string, string, AlertButton[]];
  return { title, message, press: (text: string) => buttons.find((b) => b.text === text)?.onPress?.() };
}

describe('UserProfile friendship states (§14)', () => {
  let alert: jest.SpyInstance;
  beforeEach(() => {
    alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('none → "Add friend" sends a request → "Request sent"; no Message before friendship', async () => {
    const fake = setUp('none');
    expect(await screen.findByTestId('friendship-add')).toBeOnTheScreen();
    expect(screen.getByTestId('user-profile-name')).toHaveTextContent('bob');
    expect(screen.queryByTestId('friendship-message')).toBeNull();
    expect(screen.getByTestId('user-profile-security')).toBeOnTheScreen();

    await act(async () => {
      fireEvent.press(screen.getByTestId('friendship-add'));
    });
    expect(fake.session.api.createFriendRequest).toHaveBeenCalledWith(BOB.id);
    expect(await screen.findByTestId('friendship-sent')).toBeOnTheScreen();
    expect(screen.getByTestId('user-profile-status')).toHaveTextContent('Request sent');
    expect(screen.queryByTestId('friendship-message')).toBeNull();
  });

  it('"Request sent" cancels only after confirmation', async () => {
    const fake = setUp('sent');
    fireEvent.press(await screen.findByTestId('friendship-sent'));
    expect(lastAlert(alert).title).toBe('Cancel friend request?');
    await act(async () => {
      lastAlert(alert).press('Keep');
    });
    expect(fake.session.api.deleteFriendRequest).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('friendship-sent'));
    await act(async () => {
      lastAlert(alert).press('Cancel request');
    });
    expect(fake.session.api.deleteFriendRequest).toHaveBeenCalledWith('req-out');
    expect(await screen.findByTestId('friendship-add')).toBeOnTheScreen();
  });

  it('"Accept request" makes us friends and shows Message', async () => {
    const fake = setUp('received');
    expect(await screen.findByTestId('friendship-accept')).toBeOnTheScreen();
    expect(screen.getByText('bob sent you a friend request.')).toBeOnTheScreen();
    await act(async () => {
      fireEvent.press(screen.getByTestId('friendship-accept'));
    });
    expect(fake.session.api.acceptFriendRequest).toHaveBeenCalledWith('req-in');
    expect(await screen.findByTestId('friendship-message')).toBeOnTheScreen();
    expect(screen.getByTestId('friendship-friends')).toBeOnTheScreen();
    expect(screen.getByTestId('toast')).toHaveTextContent('You and bob are now friends.');
  });

  it('Decline removes an incoming request', async () => {
    const fake = setUp('received');
    const declineButton = await screen.findByTestId('friendship-decline');
    await act(async () => {
      fireEvent.press(declineButton);
    });
    expect(fake.session.api.deleteFriendRequest).toHaveBeenCalledWith('req-in');
    expect(await screen.findByTestId('friendship-add')).toBeOnTheScreen();
  });

  it('"Friends": Message opens the conversation with the profile', async () => {
    setUp('friends');
    fireEvent.press(await screen.findByTestId('friendship-message'));
    expect(await screen.findByTestId('stub-Conversation')).toHaveTextContent(
      JSON.stringify({ peerUserId: BOB.id, peerUsername: 'bob', profile: BOB }),
    );
  });

  it('"Message" returns to the conversation the profile was opened from', async () => {
    const fake = createFakeServices({ status: 'ready', user: TEST_USER });
    fake.session.api.getUser.mockResolvedValue(BOB);
    fake.session.api.listFriends.mockResolvedValue({ friends: [BOB] });
    renderScreen('UserProfile', UserProfileScreen, fake.services, { userId: BOB.id, username: 'bob' }, {
      below: [{ name: 'Conversation', params: { peerUserId: BOB.id, peerUsername: 'bob' } }],
    });
    fireEvent.press(await screen.findByTestId('friendship-message'));
    expect(await screen.findByTestId('stub-Conversation')).toHaveTextContent(
      JSON.stringify({ peerUserId: BOB.id, peerUsername: 'bob', profile: BOB }),
    );
    // Popped back to it: the profile is gone and there is still exactly one conversation screen.
    expect(screen.queryByTestId('user-profile-name', { includeHiddenElements: true })).toBeNull();
    expect(screen.getAllByTestId('stub-Conversation', { includeHiddenElements: true })).toHaveLength(1);
  });

  it('"Friends" removes the friend only after confirmation', async () => {
    const fake = setUp('friends');
    const friendsButton = await screen.findByTestId('friendship-friends');
    await act(async () => {
      fireEvent.press(friendsButton);
    });
    expect(lastAlert(alert).title).toBe('Remove bob from your friends?');
    await act(async () => {
      lastAlert(alert).press('Remove friend');
    });
    expect(fake.session.api.removeFriend).toHaveBeenCalledWith(BOB.id);
    expect(await screen.findByTestId('friendship-add')).toBeOnTheScreen();
    expect(screen.queryByTestId('friendship-message')).toBeNull();
  });

  it('shows why an action failed', async () => {
    const fake = setUp('none');
    fake.session.api.createFriendRequest.mockRejectedValueOnce(
      new ApiError({ status: 429, code: 'rate_limited', message: 'slow down', retryAfter: 30 }),
    );
    const addButton = await screen.findByTestId('friendship-add');
    await act(async () => {
      fireEvent.press(addButton);
    });
    expect(await screen.findByTestId('user-profile-action-error')).toHaveTextContent('Too many attempts. Try again in 30 seconds.');
  });

  it('says so when the user does not exist', async () => {
    const fake = createFakeServices({ status: 'ready', user: TEST_USER });
    fake.session.api.getUser.mockRejectedValue(new ApiError({ status: 404, code: 'not_found', message: 'gone' }));
    renderScreen('UserProfile', UserProfileScreen, fake.services, { userId: BOB.id, username: 'bob' });
    expect(await screen.findByTestId('user-profile-error')).toHaveTextContent('This user no longer exists.');
  });
});
