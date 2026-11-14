import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { FriendRequest, User } from '../../core/api/types';
import { FixesApp } from '../FixesApp';
import { FriendRequestsScreen } from '../screens/friends/FriendRequestsScreen';
import { createFakeServices, TEST_USER } from './support/fakeServices';
import { renderScreen } from './support/renderScreen';

const ME: User = { id: TEST_USER.id, username: TEST_USER.username, avatar_url: null };
const BOB: User = { id: '22222222-2222-4222-8222-222222222222', username: 'bob', avatar_url: null };
const CAROL: User = { id: '33333333-3333-4333-8333-333333333333', username: 'carol', avatar_url: null };
const DAVE: User = { id: '44444444-4444-4444-8444-444444444444', username: 'dave', avatar_url: null };

function request(id: string, from: User, to: User): FriendRequest {
  return { id, from_user: from, to_user: to, created_at: new Date(Date.now() - 2 * 3600_000).toISOString() };
}

/** Lets FlatList/SectionList render their batched rows inside act(). */
async function settleList() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
}

describe('Friend requests (§14)', () => {
  it('accepts or declines incoming requests and cancels outgoing ones', async () => {
    const fake = createFakeServices({ status: 'ready', user: TEST_USER });
    const state = {
      incoming: [request('in-bob', BOB, ME), request('in-dave', DAVE, ME)],
      outgoing: [request('out-carol', ME, CAROL)],
    };
    fake.session.api.listFriendRequests.mockImplementation(async () => ({ incoming: [...state.incoming], outgoing: [...state.outgoing] }));
    fake.session.api.acceptFriendRequest.mockImplementation(async (id: string) => {
      state.incoming = state.incoming.filter((r) => r.id !== id);
      return { friend: BOB };
    });
    fake.session.api.deleteFriendRequest.mockImplementation(async (id: string) => {
      state.incoming = state.incoming.filter((r) => r.id !== id);
      state.outgoing = state.outgoing.filter((r) => r.id !== id);
    });
    renderScreen('FriendRequests', FriendRequestsScreen, fake.services);
    await screen.findByTestId('friend-requests-list');
    await settleList();
    expect(screen.getByText('Received (2)')).toBeOnTheScreen();
    expect(screen.getByText('Sent (1)')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'bob, Received 2 hours ago' })).toBeOnTheScreen();

    await act(async () => {
      fireEvent.press(screen.getByTestId('request-accept-in-bob'));
    });
    await settleList();
    expect(fake.session.api.acceptFriendRequest).toHaveBeenCalledWith('in-bob');
    expect(screen.getByTestId('toast')).toHaveTextContent('You and bob are now friends.');
    expect(screen.getByText('Received (1)')).toBeOnTheScreen();

    await act(async () => {
      fireEvent.press(screen.getByTestId('request-decline-in-dave'));
    });
    await settleList();
    expect(fake.session.api.deleteFriendRequest).toHaveBeenCalledWith('in-dave');
    expect(screen.getByText('No requests waiting for you.')).toBeOnTheScreen();

    await act(async () => {
      fireEvent.press(screen.getByTestId('request-cancel-out-carol'));
    });
    await settleList();
    expect(fake.session.api.deleteFriendRequest).toHaveBeenCalledWith('out-carol');
    expect(screen.getByTestId('friend-requests-empty')).toBeOnTheScreen();

    fireEvent.press(screen.getByRole('button', { name: 'Go to Discover' }));
    expect(await screen.findByTestId('stub-Main')).toHaveTextContent(JSON.stringify({ screen: 'Discover' }));
  });

  it('badges the Profile tab and the Friend requests entry with the incoming count', async () => {
    const fake = createFakeServices({ status: 'ready', user: TEST_USER });
    fake.session.api.listFriendRequests.mockResolvedValue({ incoming: [request('a', BOB, ME), request('b', DAVE, ME)], outgoing: [] });
    render(<FixesApp services={fake.services} />);
    await screen.findByTestId('inbox-list');
    const profileTab = await screen.findByRole('button', { name: /Profile/ });
    expect(profileTab).toHaveTextContent('2', { exact: false });

    fireEvent.press(profileTab);
    expect(await screen.findByRole('button', { name: 'Friend requests, 2 new' })).toBeOnTheScreen();
  });
});
