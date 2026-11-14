import { fireEvent, render, screen } from '@testing-library/react-native';

import type { MessageRow, MessageStatus } from '../../core/db/types';
import { MessageBubble } from '../components';

const ID = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';

function message(patch: Partial<MessageRow> = {}): MessageRow {
  return {
    id: ID,
    peer_user_id: '5d9b1c2e-3f4a-4b5c-9d6e-7f8a9b0c1d2e',
    direction: 'out',
    sender_user_id: '6f1c2a54-0a3b-4c5d-8e9f-1a2b3c4d5e6f',
    body: 'hello there',
    sent_at: 1_763_000_000_000,
    server_ts: 1_763_000_000_100,
    sort_ts: 1_763_000_000_100,
    received_at: null,
    status: 'sent',
    ...patch,
  };
}

const hidden = { includeHiddenElements: true };

describe('MessageBubble', () => {
  it('puts my messages on the right and theirs on the left', () => {
    const { rerender } = render(<MessageBubble message={message()} onRetry={jest.fn()} />);
    expect(screen.getByTestId(`message-${ID}`)).toHaveStyle({ alignItems: 'flex-end' });
    expect(screen.getByText('hello there')).toHaveStyle({ color: '#FFFFFF' });

    rerender(<MessageBubble message={message({ direction: 'in', status: 'received' })} onRetry={jest.fn()} />);
    expect(screen.getByTestId(`message-${ID}`)).toHaveStyle({ alignItems: 'flex-start' });
    expect(screen.getByText('hello there')).toHaveStyle({ color: '#000000' });
    // Incoming messages carry no ticks.
    expect(screen.queryByTestId(`status-${ID}`, hidden)).toBeNull();
  });

  it.each([
    ['pending', 'Sending'],
    ['sent', 'Sent'],
    ['delivered', 'Delivered'],
    ['read', 'Read'],
    ['failed', 'Not sent'],
  ] as [MessageStatus, string][])('shows the %s tick on my messages', (status, label) => {
    render(<MessageBubble message={message({ status })} onRetry={jest.fn()} />);
    expect(screen.getByTestId(`status-${ID}`, hidden).props.accessibilityLabel).toBe(label);
    // The bubble itself announces body, time and status in one go.
    expect(screen.getByLabelText(new RegExp(`^You: hello there\\. .*\\. ${label}$`))).toBeOnTheScreen();
  });

  it('retries a failed message on tap', () => {
    const onRetry = jest.fn();
    render(<MessageBubble message={message({ status: 'failed' })} onRetry={onRetry} />);
    expect(screen.getByText('Not sent. Tap to retry.')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button'));
    expect(onRetry).toHaveBeenCalledWith(ID);
  });

  it('does not offer a retry for other statuses', () => {
    render(<MessageBubble message={message({ status: 'delivered' })} onRetry={jest.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('Not sent. Tap to retry.')).toBeNull();
  });

  it('centres system messages without ticks', () => {
    render(
      <MessageBubble
        message={message({ direction: 'system', sender_user_id: null, status: 'none', body: "bob's safety code changed" })}
        onRetry={jest.fn()}
      />,
    );
    expect(screen.getByTestId(`message-${ID}`)).toHaveStyle({ alignItems: 'center' });
    expect(screen.getByText("bob's safety code changed")).toBeOnTheScreen();
    expect(screen.queryByTestId(`status-${ID}`, hidden)).toBeNull();
  });
});
