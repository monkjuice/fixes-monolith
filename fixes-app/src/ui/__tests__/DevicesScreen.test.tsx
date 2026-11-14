import { act, fireEvent, screen } from '@testing-library/react-native';
import { Alert, type AlertButton } from 'react-native';

import type { MyDevice } from '../../core/api/types';
import { generateDeviceKeyPair } from '../../core/crypto/deviceKeys';
import { toBase64 } from '../../core/crypto/encoding';
import { generateIdentityKeyPair, signDeviceCertificate, type IdentityKeyPair } from '../../core/crypto/identity';
import { DevicesScreen } from '../screens/settings/DevicesScreen';
import { createFakeServices, TEST_USER } from './support/fakeServices';
import { renderScreen } from './support/renderScreen';

const identity = generateIdentityKeyPair();
const USER = { ...TEST_USER, identity_key: toBase64(identity.publicKey) };
const HOUR = 60 * 60 * 1000;

function device(id: string, name: string, options: { certified: boolean; current?: boolean; createdAgoMs: number }): MyDevice {
  const keys = generateDeviceKeyPair();
  const created = new Date(Date.now() - options.createdAgoMs).toISOString();
  return {
    id,
    name,
    public_key: toBase64(keys.publicKey),
    certificate: options.certified ? signDeviceCertificate(identity, USER.id, id, keys.publicKey) : null,
    created_at: created,
    last_seen_at: created,
    current: options.current ?? false,
  };
}

const THIS = device('a0000000-0000-4000-8000-000000000001', 'This phone', { certified: true, current: true, createdAgoMs: 90 * 24 * HOUR });
const OLD = device('a0000000-0000-4000-8000-000000000002', 'Old tablet', { certified: true, createdAgoMs: 200 * 24 * HOUR });
const NEW = device('a0000000-0000-4000-8000-000000000003', 'Strange phone', { certified: false, createdAgoMs: 2 * HOUR });

function setUp(options: { localIdentity?: IdentityKeyPair | null } = {}) {
  const fake = createFakeServices({ status: 'ready', user: USER });
  // The AIK this install holds (secure storage); "Linked" is judged under it.
  fake.session.getIdentity.mockResolvedValue(options.localIdentity === undefined ? identity : options.localIdentity);
  fake.session.api.listMyDevices.mockResolvedValue({ devices: [OLD, NEW, THIS] });
  renderScreen('Devices', DevicesScreen, fake.services);
  return fake;
}

describe('Devices (§8, §5.4)', () => {
  let alert: jest.SpyInstance;
  beforeEach(() => {
    alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('lists this device first, linked and not linked devices, and points out a new device', async () => {
    setUp();
    expect(await screen.findByTestId(`device-status-${THIS.id}`)).toHaveTextContent('This device');
    expect(screen.getByTestId(`device-status-${OLD.id}`)).toHaveTextContent('Linked');
    expect(screen.getByTestId(`device-status-${NEW.id}`)).toHaveTextContent('Not linked');
    expect(screen.getByTestId('devices-new-notice')).toHaveTextContent('A new device, "Strange phone", was added', { exact: false });
    // This device is logged out with Log Out, not removed from here.
    expect(screen.queryByTestId(`device-remove-${THIS.id}`)).toBeNull();
    expect(screen.getByText('3 of 10 devices')).toBeOnTheScreen();
  });

  it.each([
    // A server that substituted its own account key (USER.identity_key) and certified devices under it.
    ['holds another identity key than the server reports', generateIdentityKeyPair()],
    // Nothing can be vouched for without an identity on this install.
    ['holds no identity key', null],
  ])("judges devices under this phone's identity key when it %s", async (_label, localIdentity) => {
    setUp({ localIdentity });
    expect(await screen.findByTestId(`device-status-${OLD.id}`)).toHaveTextContent('Not linked');
    expect(screen.getByTestId(`device-status-${NEW.id}`)).toHaveTextContent('Not linked');
  });

  it('removes a device only after confirmation, then reloads the list', async () => {
    const fake = setUp();
    const remove = await screen.findByTestId(`device-remove-${NEW.id}`);

    await act(async () => {
      fireEvent.press(remove);
    });
    expect(alert).toHaveBeenCalledTimes(1);
    let [title, message, buttons] = alert.mock.calls[0] as [string, string, AlertButton[]];
    expect(title).toBe('Remove "Strange phone"?');
    expect(message).toMatch(/signed out of your account/);
    await act(async () => {
      buttons.find((b) => b.text === 'Cancel')?.onPress?.();
    });
    expect(fake.session.api.revokeDevice).not.toHaveBeenCalled();

    const loadsBefore = fake.session.api.listMyDevices.mock.calls.length;
    fake.session.api.listMyDevices.mockResolvedValue({ devices: [OLD, THIS] });
    await act(async () => {
      fireEvent.press(remove);
    });
    [title, message, buttons] = alert.mock.calls[1] as [string, string, AlertButton[]];
    expect(buttons.find((b) => b.text === 'Remove')?.style).toBe('destructive');
    await act(async () => {
      buttons.find((b) => b.text === 'Remove')?.onPress?.();
    });
    expect(fake.session.api.revokeDevice).toHaveBeenCalledWith(NEW.id);
    expect(fake.session.api.listMyDevices.mock.calls.length).toBeGreaterThan(loadsBefore);
    expect(await screen.findByText('2 of 10 devices')).toBeOnTheScreen();
    expect(screen.queryByTestId(`device-${NEW.id}`)).toBeNull();
    expect(screen.queryByTestId('devices-new-notice')).toBeNull();
    expect(screen.getByTestId('toast')).toHaveTextContent('"Strange phone" was removed from your account.');
  });
});
