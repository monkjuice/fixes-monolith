import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { fromBase64Exact, toBase64 } from '../../core/crypto/encoding';
import { generateIdentityKeyPair } from '../../core/crypto/identity';
import { safetyCodeGroups } from '../../core/crypto/safetyCode';
import { createTestPhone, FakeFixesServer, randomTestPassword, type TestPhone } from '../../test-utils';
import { SecurityScreen } from '../screens/profile/SecurityScreen';
import { renderScreen, servicesOfPhone } from './support/renderScreen';

jest.setTimeout(30_000);

const SLOW = { timeout: 10_000 };
const phones: TestPhone[] = [];

afterEach(async () => {
  cleanup();
  for (const phone of phones.splice(0)) await phone.dispose();
});

/** `local`: what this install holds as its AIK when the screen opens (the account key by default). */
async function setUp(options: { pin: boolean; local?: 'account' | 'other' | 'none' }) {
  const server = new FakeFixesServer();
  const password = randomTestPassword();
  const alice = server.addUser('alice', password);
  const bob = server.addUser('bob', randomTestPassword());
  const phone = createTestPhone(server, { name: 'alice1' });
  phones.push(phone);
  await phone.login('alice', password);
  const bobKey = toBase64(generateIdentityKeyPair().publicKey);
  if (options.pin) await phone.store.contactIdentities.pinIfAbsent(bob.id, bobKey, 1);
  const aliceKey = (await phone.session.getIdentity())?.publicKey;
  if (!aliceKey) throw new Error('alice has no identity key');
  if (options.local === 'other') await phone.session.items.setIdentity(alice.id, generateIdentityKeyPair());
  if (options.local === 'none') await phone.session.items.deleteIdentity(alice.id);
  renderScreen('Security', SecurityScreen, servicesOfPhone(phone), { userId: bob.id, username: 'bob' });
  const codeWith = (key: string) => safetyCodeGroups(aliceKey, fromBase64Exact(key, 32));
  return { phone, bob, bobKey, codeWith };
}

describe('Security: safety code (§4.4, §8)', () => {
  it('shows the code both users see and marks the contact verified', async () => {
    const { phone, bob, bobKey, codeWith } = await setUp({ pin: true });
    const code = await screen.findByTestId('safety-code', {}, SLOW);
    expect(code.props.accessibilityLabel).toBe(`Safety code: ${codeWith(bobKey).join(', ')}`);
    expect(screen.getByTestId('security-status')).toHaveTextContent('Not verified yet.', { exact: false });

    await act(async () => {
      fireEvent.press(screen.getByTestId('security-toggle-verified'));
    });
    await waitFor(() => expect(screen.getByTestId('security-status')).toHaveTextContent('You have verified bob.', { exact: false }), SLOW);
    expect((await phone.store.contactIdentities.get(bob.id))?.verified).toBe(1);
    expect(screen.getByRole('button', { name: 'Mark as not verified' })).toBeOnTheScreen();
  });

  it('shows the new code of a changed key and accepts it', async () => {
    const { phone, bob, codeWith } = await setUp({ pin: true });
    await screen.findByTestId('safety-code', {}, SLOW);
    const newKey = toBase64(generateIdentityKeyPair().publicKey);
    await act(async () => {
      await phone.store.contactIdentities.setVerified(bob.id, true);
      await phone.store.contactIdentities.setPending(bob.id, newKey);
    });
    expect(await screen.findByTestId('security-pending', {}, SLOW)).toBeOnTheScreen();
    expect(screen.getByTestId('safety-code').props.accessibilityLabel).toBe(`Safety code: ${codeWith(newKey).join(', ')}`);
    expect(screen.queryByTestId('security-toggle-verified')).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByTestId('security-accept'));
    });
    await waitFor(() => expect(screen.queryByTestId('security-pending')).toBeNull(), SLOW);
    const pin = await phone.store.contactIdentities.get(bob.id);
    expect(pin).toMatchObject({ identity_key: newKey, pending_identity_key: null, verified: 0 });
    expect(screen.getByTestId('security-status')).toHaveTextContent('Not verified yet.', { exact: false });
  });

  it('explains that there is no code before the first message', async () => {
    await setUp({ pin: false });
    expect(await screen.findByTestId('security-no-code', {}, SLOW)).toHaveTextContent(/once you and bob have exchanged a message/);
  });

  it('shows no code when this phone holds another identity key than the server reports for the account', async () => {
    // A server substituting its own key for mine could otherwise make both users' codes match.
    await setUp({ pin: true, local: 'other' });
    expect(await screen.findByTestId('security-identity-warning', {}, SLOW)).toHaveTextContent(/does not match the one the server reports/);
    expect(screen.queryByTestId('safety-code')).toBeNull();
    expect(screen.queryByTestId('security-toggle-verified')).toBeNull();
  });

  it('shows no code when this phone does not hold the identity key yet', async () => {
    await setUp({ pin: true, local: 'none' });
    expect(await screen.findByTestId('security-identity-warning', {}, SLOW)).toHaveTextContent(/does not hold your security identity/);
    expect(screen.queryByTestId('safety-code')).toBeNull();
  });
});
