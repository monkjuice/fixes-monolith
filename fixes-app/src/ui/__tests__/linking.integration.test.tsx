import { act, cleanup, fireEvent, screen } from '@testing-library/react-native';

import { uuidv4 } from '../../core/crypto/random';
import type { MessageRow } from '../../core/db/types';
import { createTestPhone, FakeFixesServer, randomTestPassword, waitFor as waitUntil, type TestPhone } from '../../test-utils';
import { LinkDeviceScreen } from '../screens/settings/LinkDeviceScreen';
import { ReceiveHistoryScreen } from '../screens/settings/ReceiveHistoryScreen';
import { renderScreen, servicesOfPhone } from './support/renderScreen';

/**
 * §9 with the real engines of two phones of one account: "Link a new device" scanning (the camera is
 * replaced by a button that "scans" `mockScanData`) and "Receive history" on an already linked device.
 */

let mockScanData = '';

jest.mock('expo-camera', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Pressable, Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    useCameraPermissions: () => [{ granted: true, canAskAgain: true, status: 'granted', expires: 'never' }, jest.fn(), jest.fn()],
    CameraView: ({ onBarcodeScanned }: { onBarcodeScanned?: (result: { type: string; data: string }) => void }) =>
      React.createElement(
        Pressable,
        { testID: 'fake-camera', onPress: () => onBarcodeScanned?.({ type: 'qr', data: mockScanData }) },
        React.createElement(Text, null, 'camera'),
      ),
  };
});

jest.setTimeout(30_000);

const SLOW = { timeout: 10_000 };
const phones: TestPhone[] = [];

afterEach(async () => {
  cleanup();
  for (const phone of phones.splice(0)) await phone.dispose();
});

async function eventually(predicate: () => boolean | Promise<boolean>, message?: string) {
  await act(async () => {
    await waitUntil(predicate, { message });
  });
}

/** Alice's first phone (linked) with one received message from bob in its history. */
async function linkedPhoneWithHistory() {
  const server = new FakeFixesServer();
  const password = randomTestPassword();
  server.addUser('alice', password);
  const bob = server.addUser('bob', randomTestPassword());
  server.makeFriends(server.findUser('alice')!.id, bob.id);
  const first = createTestPhone(server, { name: 'alice1' });
  phones.push(first);
  await first.login('alice', password);
  const now = Date.now();
  const message: MessageRow = {
    id: uuidv4(),
    peer_user_id: bob.id,
    direction: 'in',
    sender_user_id: bob.id,
    body: 'kept in the history',
    sent_at: now,
    server_ts: now,
    sort_ts: now,
    received_at: now,
    status: 'read',
  };
  await first.store.transaction(async (tx) => {
    await tx.conversations.insertIfMissing({ peerUserId: bob.id, peerUsername: 'bob', peerAvatarUrl: null, lastActivityAt: now });
    await tx.messages.insertOrIgnore(message);
  });
  return { server, password, first, message };
}

async function press(testID: string) {
  const element = await screen.findByTestId(testID, {}, SLOW);
  await act(async () => {
    fireEvent.press(element);
  });
}

describe('Link a new device (§9 steps 3–4)', () => {
  it('scans, verifies the device, links it and sends the history', async () => {
    const { server, password, first, message } = await linkedPhoneWithHistory();
    const second = createTestPhone(server, { name: 'alice2' });
    phones.push(second);
    await second.login('alice', password);
    expect(second.session.getState().status).toBe('needsLink');
    const qr = await second.engine.createLinkQr();

    renderScreen('LinkDevice', LinkDeviceScreen, servicesOfPhone(first));

    // Anything that is not a link code is refused while the scanner keeps running.
    mockScanData = 'https://example.com/not-a-link';
    await press('fake-camera');
    expect(screen.getByTestId('link-notice')).toHaveTextContent('This is not a Fixes link code.', { exact: false });

    mockScanData = qr;
    await press('fake-camera');
    expect(await screen.findByTestId('link-verify-name', {}, SLOW)).toHaveTextContent('alice2');
    expect(screen.queryByTestId('link-notice')).toBeNull();

    await press('link-confirm');
    expect(await screen.findByTestId('link-done', {}, SLOW)).toHaveTextContent('alice2 is linked and has your history.', {
      exact: false,
    });
    await eventually(() => second.session.getState().status === 'ready', 'second phone linked');
    await eventually(async () => (await second.store.messages.get(message.id))?.body === message.body, 'history arrived');

    await press('link-finish');
    expect(await screen.findByTestId('stub-Main', {}, SLOW)).toBeOnTheScreen();
    expect(first.engine.outgoingLink.get().phase).toBe('idle');
  });

  it('refuses a code whose device is not logged in to the account', async () => {
    const { server, password, first } = await linkedPhoneWithHistory();
    const second = createTestPhone(server, { name: 'alice2' });
    phones.push(second);
    await second.login('alice', password);
    const qr = await second.engine.createLinkQr();
    // The new device was revoked (e.g. logged out) after showing its code.
    server.revoke(second.deviceId);

    renderScreen('LinkDevice', LinkDeviceScreen, servicesOfPhone(first));
    mockScanData = qr;
    await press('fake-camera');
    expect(await screen.findByTestId('link-verify-error', {}, SLOW)).toHaveTextContent(
      'The new device is not logged in to your account.',
      { exact: false },
    );
    await press('link-scan-again');
    expect(await screen.findByTestId('fake-camera')).toBeOnTheScreen();
  });
});

describe('Receive history on a linked device (§13 gap)', () => {
  it('shows a link code and imports the history sent from the other device', async () => {
    const { server, password, first, message } = await linkedPhoneWithHistory();
    const second = createTestPhone(server, { name: 'alice2' });
    phones.push(second);
    // Already linked (same install's identity), but without the history.
    second.copyIdentityFrom(first);
    await second.login('alice', password);
    expect(second.session.getState().status).toBe('ready');
    await eventually(() => second.engine.getState().connection === 'ready', 'second phone connected');

    renderScreen('ReceiveHistory', ReceiveHistoryScreen, servicesOfPhone(second));
    expect(await screen.findByTestId('link-qr', {}, SLOW)).toBeOnTheScreen();
    const qr = second.engine.incomingLink.get().qr;
    if (!qr) throw new Error('no link code');

    await act(async () => {
      await first.engine.startLink(qr);
    });
    expect(first.engine.outgoingLink.get().phase).toBe('done');
    expect(await screen.findByTestId('receive-history-done', {}, SLOW)).toHaveTextContent('1 message was added.', { exact: false });
    expect((await second.store.messages.get(message.id))?.body).toBe(message.body);
  });
});
