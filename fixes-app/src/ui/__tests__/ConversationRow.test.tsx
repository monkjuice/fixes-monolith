import { fireEvent, render, screen } from '@testing-library/react-native';

import type { InboxRow } from '../../core/db/types';
import { Avatar, ConversationRow } from '../components';
import { statusColors } from '../theme';

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const MINUTE = 60_000;

function inboxRow(patch: Partial<InboxRow> = {}): InboxRow {
  return {
    peer_user_id: '5d9b1c2e-3f4a-4b5c-9d6e-7f8a9b0c1d2e',
    peer_username: 'bob',
    peer_avatar_url: null,
    last_activity_at: NOW - 5 * MINUTE,
    unread_count: 0,
    profile_refreshed_at: null,
    last_message_id: '1e2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b',
    last_direction: 'out',
    last_body: 'see you tomorrow',
    last_status: 'sent',
    last_sort_ts: NOW - 5 * MINUTE,
    ...patch,
  };
}

function renderRow(row: InboxRow, onPress = jest.fn()) {
  render(<ConversationRow row={row} now={NOW} onPress={onPress} />);
  return onPress;
}

describe('ConversationRow (§14 inbox rows)', () => {
  it('shows an unread incoming message with a gray ← arrow, in bold, with the relative time', () => {
    renderRow(inboxRow({ last_direction: 'in', last_status: 'received', last_body: 'are you there?', unread_count: 2 }));
    const arrow = screen.getByTestId('conversation-arrow');
    expect(arrow).toHaveTextContent('←');
    expect(arrow).toHaveStyle({ color: statusColors.incoming });
    expect(screen.getByTestId('conversation-username')).toHaveStyle({ fontWeight: '700' });
    expect(screen.getByTestId('conversation-preview')).toHaveTextContent('are you there?');
    expect(screen.getByTestId('conversation-preview')).toHaveStyle({ fontWeight: '700' });
    expect(screen.getByTestId('conversation-time')).toHaveTextContent('5 minutes ago');
    expect(screen.getByRole('button', { name: /bob, Unread, are you there\?/ })).toBeOnTheScreen();
  });

  it('is not bold once the incoming message was read', () => {
    renderRow(inboxRow({ last_direction: 'in', last_status: 'read' }));
    expect(screen.getByTestId('conversation-arrow')).toHaveTextContent('←');
    expect(screen.getByTestId('conversation-username')).not.toHaveStyle({ fontWeight: '700' });
  });

  it.each([
    ['read', '#FFA500'],
    ['delivered', '#0000FF'],
    ['sent', '#D3D3D3'],
    ['pending', '#FF0000'],
    ['failed', '#FF0000'],
  ] as const)('colours the → arrow of an outgoing %s message %s', (status, color) => {
    renderRow(inboxRow({ last_status: status }));
    const arrow = screen.getByTestId('conversation-arrow');
    expect(arrow).toHaveTextContent('→');
    expect(arrow).toHaveStyle({ color });
    expect(screen.getByTestId('conversation-username')).not.toHaveStyle({ fontWeight: '700' });
    if (status === 'failed') expect(screen.getByTestId('conversation-retry-icon')).toBeOnTheScreen();
    else expect(screen.queryByTestId('conversation-retry-icon')).toBeNull();
  });

  it('uses the legacy relative time wording', () => {
    renderRow(inboxRow({ last_sort_ts: NOW - 90 * MINUTE }));
    expect(screen.getByTestId('conversation-time')).toHaveTextContent('an hour ago');
  });

  it('handles a conversation without messages and reports taps', () => {
    const row = inboxRow({ last_message_id: null, last_direction: null, last_body: null, last_status: null, last_sort_ts: null });
    const onPress = renderRow(row);
    expect(screen.queryByTestId('conversation-arrow')).toBeNull();
    expect(screen.getByTestId('conversation-preview')).toHaveTextContent('No messages yet');
    fireEvent.press(screen.getByRole('button'));
    expect(onPress).toHaveBeenCalledWith(row);
  });
});

describe('Avatar', () => {
  it('falls back to the placeholder when the image fails to load (§13)', () => {
    render(<Avatar uri="https://media.example.test/avatars/a.jpg" testID="avatar" />);
    const image = screen.getByTestId('avatar-image', { includeHiddenElements: true });
    fireEvent(image, 'error', { nativeEvent: { error: 'HTTP 404' } });
    expect(screen.queryByTestId('avatar-image', { includeHiddenElements: true })).toBeNull();
    expect(screen.getByTestId('avatar-placeholder', { includeHiddenElements: true })).toBeOnTheScreen();
  });

  it('shows the placeholder without an avatar', () => {
    render(<Avatar uri={null} testID="avatar" />);
    expect(screen.getByTestId('avatar-placeholder', { includeHiddenElements: true })).toBeOnTheScreen();
  });
});
