import { act, cleanup, fireEvent, screen } from '@testing-library/react-native';
import { Alert, type AlertButton } from 'react-native';

import { createTestPhone, FakeFixesServer, randomTestPassword, waitFor as waitUntil, type TestPhone } from '../../test-utils';
import { SettingsScreen } from '../screens/settings/SettingsScreen';
import { renderScreen, servicesOfPhone } from './support/renderScreen';

jest.setTimeout(30_000);

const phones: TestPhone[] = [];

afterEach(async () => {
  cleanup();
  jest.restoreAllMocks();
  for (const phone of phones.splice(0)) await phone.dispose();
});

describe('Erase this device with a running engine (§12.1)', () => {
  it('revokes the device, deletes every local item and signs out without engine errors', async () => {
    const server = new FakeFixesServer();
    const password = randomTestPassword();
    const alice = server.addUser('alice', password);
    const phone = createTestPhone(server, { name: 'alice1' });
    phones.push(phone);
    await phone.login('alice', password);
    await act(async () => {
      await waitUntil(() => phone.engine.getState().connection === 'ready');
    });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const press = (index: number, text: string) =>
      (alert.mock.calls[index][2] as AlertButton[]).find((b) => b.text === text)?.onPress?.();

    renderScreen('Settings', SettingsScreen, servicesOfPhone(phone));
    const erase = await screen.findByTestId('settings-erase');
    await act(async () => {
      fireEvent.press(erase);
    });
    await act(async () => {
      press(0, 'Continue');
    });
    await act(async () => {
      press(1, 'Erase');
      await waitUntil(() => phone.session.getState().status === 'signedOut');
    });

    expect(phone.session.getState()).toMatchObject({ status: 'signedOut', signedOutReason: 'erased' });
    expect(server.devicesOf(alice.id)[0].revoked).toBe(true);
    expect([...phone.secureStore.items.keys()]).toEqual([]);
    expect(phone.engine.getState().status).toBe('stopped');
    expect(phone.logger.errors()).toEqual([]);
  });
});
