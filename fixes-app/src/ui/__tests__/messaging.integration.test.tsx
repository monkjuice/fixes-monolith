import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { toBase64 } from '../../core/crypto/encoding';
import { generateIdentityKeyPair } from '../../core/crypto/identity';
import { randomBytes } from '../../core/crypto/random';
import type { FixesServices } from '../../hooks';
import {
  createTestPhone,
  FakeFixesServer,
  randomTestPassword,
  waitFor as waitUntil,
  type TestPhone,
} from '../../test-utils';
import { FixesApp } from '../FixesApp';

/**
 * The real screens against real phones (SessionManager + MessagingEngine on FakeFixesServer): Alice
 * uses the UI, Bob is driven through his engine.
 */

jest.setTimeout(30_000);

const SLOW = { timeout: 10_000 };
const hidden = { includeHiddenElements: true };
const phones: TestPhone[] = [];

afterEach(async () => {
  // Unmount first so no screen keeps observing a database that dispose() closes.
  cleanup();
  for (const phone of phones.splice(0)) await phone.dispose();
});

function servicesOf(phone: TestPhone): FixesServices {
  return { session: phone.session, messaging: phone.engine, backup: phone.backup };
}

/**
 * Waits for engine or database state. Screens re-render while it polls (lists batch their rendering
 * on timers), so the wait runs inside act().
 */
async function eventually(predicate: () => boolean | Promise<boolean>, message?: string) {
  await act(async () => {
    await waitUntil(predicate, { message });
  });
}

async function setUp() {
  const server = new FakeFixesServer();
  const password = randomTestPassword();
  const alice = server.addUser('alice', password);
  const bob = server.addUser('bob', password);
  server.makeFriends(alice.id, bob.id);
  const alicePhone = createTestPhone(server, { name: 'alice1' });
  const bobPhone = createTestPhone(server, { name: 'bob1' });
  phones.push(alicePhone, bobPhone);
  await bobPhone.login('bob', password);
  await waitUntil(() => bobPhone.engine.getState().connection === 'ready');

  render(<FixesApp services={servicesOf(alicePhone)} />);
  fireEvent.changeText(await screen.findByTestId('login-username', {}, SLOW), 'alice');
  fireEvent.changeText(screen.getByTestId('login-password'), password);
  await act(async () => {
    fireEvent.press(screen.getByTestId('login-submit'));
  });
  await screen.findByTestId('inbox-list', {}, SLOW);
  await eventually(() => alicePhone.engine.getState().connection === 'ready');
  return { server, alice, bob, alicePhone, bobPhone };
}

async function openConversationWithBob() {
  fireEvent.press(screen.getByRole('button', { name: 'New conversation' }));
  fireEvent.press(await screen.findByRole('button', { name: 'bob' }, SLOW));
  await screen.findByTestId('composer-input', {}, SLOW);
}

async function send(text: string) {
  fireEvent.changeText(screen.getByTestId('composer-input'), text);
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Send' }));
  });
}

async function onlyMessageId(phone: TestPhone, peer: string, body: string): Promise<string> {
  const rows = await phone.store.messages.listPage(peer, { limit: 100 });
  const row = rows.find((m) => m.body === body);
  if (!row) throw new Error(`no message "${body}"`);
  return row.id;
}

describe('messaging screens with a real engine', () => {
  it('starts a conversation from the friends list, sends with ticks, receives and marks read', async () => {
    const { alice, bob, alicePhone, bobPhone } = await setUp();
    await openConversationWithBob();
    expect(screen.getByText('No messages yet')).toBeOnTheScreen();

    await send('hello bob');
    expect(screen.getByTestId('composer-input').props.value).toBe('');
    const sentId = await onlyMessageId(alicePhone, bob.id, 'hello bob');
    expect(screen.getByTestId(`message-${sentId}`)).toHaveStyle({ alignItems: 'flex-end' });
    // pending → sent → delivered once Bob's phone stored it.
    await waitFor(() => expect(screen.getByTestId(`status-${sentId}`, hidden).props.accessibilityLabel).toBe('Delivered'), SLOW);

    // Bob answers while Alice looks at the conversation: it shows on the left and is read at once.
    await act(async () => {
      await bobPhone.engine.sendMessage(alice.id, 'hi alice');
    });
    const replyId = await onlyMessageId(bobPhone, alice.id, 'hi alice');
    expect(await screen.findByText('hi alice', {}, SLOW)).toBeOnTheScreen();
    expect(screen.getByTestId(`message-${replyId}`)).toHaveStyle({ alignItems: 'flex-start' });
    await eventually(async () => (await bobPhone.store.messages.get(replyId))?.status === 'read', 'read receipt at Bob');

    // Bob reads Alice's message: her tick turns to Read.
    await act(async () => {
      await bobPhone.engine.markConversationRead(alice.id);
    });
    await waitFor(() => expect(screen.getByTestId(`status-${sentId}`, hidden).props.accessibilityLabel).toBe('Read'), SLOW);
  });

  it('shows the inbox row for a new incoming message in bold and reads it when opened', async () => {
    const { alice, bob, alicePhone, bobPhone } = await setUp();
    await act(async () => {
      await bobPhone.engine.sendMessage(alice.id, 'are you there?');
    });
    const row = await screen.findByTestId(`conversation-${bob.id}`, {}, SLOW);
    await waitFor(() => expect(screen.getByTestId('conversation-preview')).toHaveTextContent('are you there?'), SLOW);
    expect(screen.getByTestId('conversation-arrow')).toHaveTextContent('←');
    expect(screen.getByTestId('conversation-username')).toHaveStyle({ fontWeight: '700' });

    fireEvent.press(row);
    expect(await screen.findByText('are you there?', {}, SLOW)).toBeOnTheScreen();
    const id = await onlyMessageId(bobPhone, alice.id, 'are you there?');
    await eventually(async () => (await bobPhone.store.messages.get(id))?.status === 'read', 'read receipt');
    await eventually(async () => (await alicePhone.store.conversations.get(bob.id))?.unread_count === 0);
  });

  it('marks a refused message failed and retries it on tap', async () => {
    const { server, alice, bob, alicePhone } = await setUp();
    await openConversationWithBob();
    server.unfriend(alice.id, bob.id);
    await send('still friends?');
    const id = await onlyMessageId(alicePhone, bob.id, 'still friends?');
    expect(await screen.findByText('Not sent. Tap to retry.', {}, SLOW)).toBeOnTheScreen();

    server.makeFriends(alice.id, bob.id);
    await act(async () => {
      fireEvent.press(screen.getByTestId(`retry-${id}`));
    });
    await waitFor(() => expect(screen.getByTestId(`status-${id}`, hidden).props.accessibilityLabel).toBe('Delivered'), SLOW);
    expect(screen.queryByText('Not sent. Tap to retry.')).toBeNull();
  });

  it('blocks sending behind the safety-code banner until Accept (§8)', async () => {
    const { bob, alicePhone } = await setUp();
    await openConversationWithBob();
    await send('before the change');
    await eventually(async () => (await alicePhone.store.contactIdentities.get(bob.id)) !== null, 'Bob pinned');

    // What the device directory records when Bob's identity key changes.
    const newKey = toBase64(generateIdentityKeyPair().publicKey);
    await act(async () => {
      await alicePhone.store.contactIdentities.setPending(bob.id, newKey);
    });
    expect(await screen.findByTestId('safety-code-banner', {}, SLOW)).toHaveTextContent(/bob's safety code changed/);
    expect(screen.getByTestId('composer-input').props.editable).toBe(false);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Accept' }));
    });
    await waitFor(() => expect(screen.queryByTestId('safety-code-banner')).toBeNull(), SLOW);
    expect((await alicePhone.store.contactIdentities.get(bob.id))?.identity_key).toBe(newKey);
    expect(screen.getByTestId('composer-input').props.editable).toBe(true);
  });

  it('shows consecutive undecryptable messages as one counting notice, never as the inbox preview', async () => {
    const { server, alice, bob, alicePhone, bobPhone } = await setUp();
    await act(async () => {
      await bobPhone.engine.sendMessage(alice.id, 'readable');
    });
    const row = await screen.findByTestId(`conversation-${bob.id}`, {}, SLOW);
    await waitFor(() => expect(screen.getByTestId('conversation-preview')).toHaveTextContent('readable'), SLOW);
    const notices = async () =>
      (await alicePhone.store.messages.listPage(bob.id, { limit: 100 })).filter((m) => m.direction === 'system');
    // Envelopes from Bob's real device that do not decrypt (§13).
    const junk = () =>
      server.injectEnvelope({
        recipientDeviceId: alicePhone.deviceId,
        senderUserId: bob.id,
        senderDeviceId: bobPhone.deviceId,
        nonce: toBase64(randomBytes(24)),
        ciphertext: toBase64(randomBytes(300)),
      });

    await act(async () => {
      junk();
    });
    await eventually(async () => (await notices()).length === 1, 'notice stored');
    // The preview comes from the newest non-system message, and the notice is not activity.
    expect(screen.getByTestId('conversation-preview')).toHaveTextContent('readable');

    fireEvent.press(row);
    expect(await screen.findByText('A message from bob could not be decrypted', {}, SLOW)).toBeOnTheScreen();
    const [notice] = await notices();
    await act(async () => {
      junk();
      junk();
    });
    // The same bubble now counts all three.
    await waitFor(
      () => expect(screen.getByTestId(`message-${notice.id}`)).toHaveTextContent('3 messages from bob could not be decrypted'),
      SLOW,
    );
    expect(screen.queryByText('A message from bob could not be decrypted')).toBeNull();
    expect(await notices()).toHaveLength(1);
  });

  it('filters the inbox by username, shows and dismisses the gap banner', async () => {
    const { bob, alicePhone, server } = await setUp();
    const carol = server.addUser('carol', randomTestPassword());
    await act(async () => {
      await alicePhone.store.transaction(async (tx) => {
        await tx.conversations.insertIfMissing({ peerUserId: bob.id, peerUsername: 'bob', peerAvatarUrl: null, lastActivityAt: 2 });
        await tx.conversations.insertIfMissing({ peerUserId: carol.id, peerUsername: 'Carol', peerAvatarUrl: null, lastActivityAt: 1 });
      });
    });
    await screen.findByTestId(`conversation-${carol.id}`, {}, SLOW);
    expect(screen.getByTestId(`conversation-${bob.id}`)).toBeOnTheScreen();

    fireEvent.changeText(screen.getByTestId('inbox-search'), 'CAR');
    expect(screen.queryByTestId(`conversation-${bob.id}`)).toBeNull();
    expect(screen.getByTestId(`conversation-${carol.id}`)).toBeOnTheScreen();
    fireEvent.changeText(screen.getByTestId('inbox-search'), 'zed');
    expect(screen.getByText('No conversations match your search')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByTestId(`conversation-${bob.id}`)).toBeOnTheScreen();

    await act(async () => {
      alicePhone.engine.state.update({ gap: true });
    });
    // exact: false because the banner's icons render as glyph characters next to the text.
    expect(screen.getByTestId('gap-banner')).toHaveTextContent(
      'This device missed some messages — link it again from another device to recover history',
      { exact: false },
    );
    fireEvent.press(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('gap-banner')).toBeNull();
  });
});
