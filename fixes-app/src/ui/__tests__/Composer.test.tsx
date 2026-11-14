import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { Composer } from '../components';

const EMOJI = '\u{1F600}';

function renderComposer(onSend = jest.fn(async (_body: string) => true), props: { disabled?: boolean; disabledReason?: string } = {}) {
  render(<Composer onSend={onSend} {...props} />);
  return onSend;
}

function type(text: string) {
  fireEvent.changeText(screen.getByTestId('composer-input'), text);
}

describe('Composer', () => {
  it('enables Send only for a non-blank message and sends it trimmed', async () => {
    const onSend = renderComposer();
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    type('   \n ');
    expect(send).toBeDisabled();

    type('  hi bob \n');
    expect(send).toBeEnabled();
    await act(async () => {
      fireEvent.press(send);
    });
    expect(onSend).toHaveBeenCalledWith('hi bob');
    expect(screen.getByTestId('composer-input').props.value).toBe('');
  });

  it('keeps what was typed while the previous message was being stored', async () => {
    let finish!: (stored: boolean) => void;
    const onSend = renderComposer(jest.fn((_body: string) => new Promise<boolean>((resolve) => (finish = resolve))));
    type('first message');
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    });
    expect(onSend).toHaveBeenCalledWith('first message');
    // Storing waits (e.g. behind a history import); the user starts the next message meanwhile.
    type('second message, not sent yet');
    await act(async () => {
      finish(true);
    });
    expect(screen.getByTestId('composer-input').props.value).toBe('second message, not sent yet');

    // Typing on after the sent text keeps only the new part.
    type('third');
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    });
    type('third and fourth');
    await act(async () => {
      finish(true);
    });
    expect(screen.getByTestId('composer-input').props.value).toBe('and fourth');
  });

  it('keeps the text when the message could not be stored', async () => {
    const onSend = renderComposer(jest.fn(async (_body: string) => false));
    type('try again later');
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('composer-input').props.value).toBe('try again later');
  });

  it('counts the 4000-character limit in code points (§7.1)', () => {
    renderComposer();
    // 4000 emoji are 8000 UTF-16 units but exactly 4000 characters: allowed.
    type(EMOJI.repeat(4000));
    expect(screen.getByTestId('composer-counter')).toHaveTextContent('4000/4000');
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();

    type(`${EMOJI.repeat(4000)}!`);
    expect(screen.getByTestId('composer-counter')).toHaveTextContent('4001/4000');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    type('short');
    expect(screen.queryByTestId('composer-counter')).toBeNull();
  });

  it('is read-only while sending is blocked, saying why', () => {
    const onSend = renderComposer(undefined, { disabled: true, disabledReason: 'Accept the new safety code to send messages' });
    const input = screen.getByTestId('composer-input');
    expect(input.props.editable).toBe(false);
    expect(input.props.placeholder).toBe('Accept the new safety code to send messages');
    type('hello');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).not.toHaveBeenCalled();
  });
});
