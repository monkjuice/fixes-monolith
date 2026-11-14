import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { NetworkError } from '../../core/api/errors';
import { FixesApp } from '../FixesApp';
import { SEARCH_RULE } from '../presentation/search';
import { createFakeServices, TEST_USER } from './support/fakeServices';

const BOB = { id: '22222222-2222-4222-8222-222222222222', username: 'bob', avatar_url: null };
const BOBBY = { id: '33333333-3333-4333-8333-333333333333', username: 'bobby', avatar_url: null };

async function openDiscover() {
  const fake = createFakeServices({ status: 'ready', user: TEST_USER });
  render(<FixesApp services={fake.services} />);
  await screen.findByTestId('inbox-list');
  fireEvent.press(screen.getByRole('button', { name: /Discover/ }));
  await screen.findByTestId('discover-start');
  return fake;
}

/**
 * FlatList renders its rows in batches on a timer; letting that timer run inside act() keeps its state
 * updates from landing outside act (React's warning) in whatever runs next.
 */
async function settleList() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
}

async function search(text: string) {
  fireEvent.changeText(screen.getByTestId('discover-search'), text);
  await act(async () => {
    fireEvent(screen.getByTestId('discover-search'), 'submitEditing');
  });
  await settleList();
}

describe('Discover → search users (§14)', () => {
  it('refuses invalid queries locally, without calling the server', async () => {
    const fake = await openDiscover();
    for (const text of ['bob smith', 'bob-smith', 'x'.repeat(31), '   ', 'bób']) {
      await search(text);
      expect(screen.getByTestId('discover-input-error')).toHaveTextContent(SEARCH_RULE);
    }
    expect(fake.session.api.searchUsers).not.toHaveBeenCalled();
  });

  it('searches a valid query, lists the results and opens a profile', async () => {
    const fake = await openDiscover();
    fake.session.api.searchUsers.mockResolvedValueOnce({ users: [BOB, BOBBY, TEST_USER] });
    await search('  bob ');
    expect(fake.session.api.searchUsers).toHaveBeenCalledWith('bob');
    expect(screen.queryByTestId('discover-input-error')).toBeNull();
    expect(screen.getByRole('button', { name: 'bob' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'bobby' })).toBeOnTheScreen();
    // The caller never appears in their own results.
    expect(screen.queryByRole('button', { name: 'alice' })).toBeNull();

    fake.session.api.getUser.mockResolvedValue(BOB);
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'bob' }));
    });
    expect(await screen.findByTestId('friendship-add')).toBeOnTheScreen();
    expect(fake.session.api.getUser).toHaveBeenCalledWith(BOB.id);
  });

  it('shows an empty result and a retryable error', async () => {
    const fake = await openDiscover();
    await search('nobody');
    expect(screen.getByText('No users found')).toBeOnTheScreen();

    fake.session.api.searchUsers.mockRejectedValueOnce(new NetworkError('offline', 'Network request failed'));
    await search('bob');
    expect(screen.getByTestId('discover-error')).toHaveTextContent('No internet connection', { exact: false });
    fake.session.api.searchUsers.mockResolvedValueOnce({ users: [BOB] });
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    });
    await settleList();
    expect(screen.getByRole('button', { name: 'bob' })).toBeOnTheScreen();
    expect(fake.session.api.searchUsers).toHaveBeenLastCalledWith('bob');
  });
});
