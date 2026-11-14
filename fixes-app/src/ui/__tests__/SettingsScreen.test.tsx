import { act, fireEvent, screen } from '@testing-library/react-native';
import { Alert, type AlertButton } from 'react-native';

import { ApiError } from '../../core/api/errors';
import { ChangePasswordScreen } from '../screens/settings/ChangePasswordScreen';
import { SettingsScreen } from '../screens/settings/SettingsScreen';
import { createFakeServices, TEST_USER } from './support/fakeServices';
import { renderScreen } from './support/renderScreen';

function alertCall(alert: jest.SpyInstance, index: number) {
  const [title, message, buttons] = alert.mock.calls[index] as [string, string, AlertButton[]];
  return { title, message, press: (text: string) => buttons.find((b) => b.text === text)?.onPress?.() };
}

describe('Settings (§14)', () => {
  let alert: jest.SpyInstance;
  beforeEach(() => {
    alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('opens every settings screen', async () => {
    const routes: [string, string][] = [
      ['settings-devices', 'Devices'],
      ['settings-link-device', 'LinkDevice'],
      ['settings-receive-history', 'ReceiveHistory'],
      ['settings-backup', 'Backup'],
      ['settings-change-password', 'ChangePassword'],
    ];
    for (const [testID, route] of routes) {
      const fake = createFakeServices({ status: 'ready', user: TEST_USER });
      const view = renderScreen('Settings', SettingsScreen, fake.services);
      fireEvent.press(await screen.findByTestId(testID));
      expect(await screen.findByTestId(`stub-${route}`)).toBeOnTheScreen();
      view.unmount();
    }
  });

  it('erases this device only after two confirmations (§12.1)', async () => {
    const fake = createFakeServices({ status: 'ready', user: TEST_USER });
    renderScreen('Settings', SettingsScreen, fake.services);
    const erase = await screen.findByTestId('settings-erase');

    // Cancelling the first dialog stops right there.
    await act(async () => {
      fireEvent.press(erase);
    });
    expect(alertCall(alert, 0).title).toBe('Erase this device?');
    await act(async () => {
      alertCall(alert, 0).press('Cancel');
    });
    expect(alert).toHaveBeenCalledTimes(1);

    // Continuing leads to a second, final dialog; cancelling it still erases nothing.
    await act(async () => {
      fireEvent.press(erase);
    });
    await act(async () => {
      alertCall(alert, 1).press('Continue');
    });
    expect(alertCall(alert, 2).title).toBe('Erase everything on this phone?');
    await act(async () => {
      alertCall(alert, 2).press('Cancel');
    });
    expect(fake.session.eraseDevice).not.toHaveBeenCalled();

    fake.session.eraseDevice.mockResolvedValueOnce({ serverRevoked: false });
    await act(async () => {
      fireEvent.press(erase);
    });
    await act(async () => {
      alertCall(alert, 3).press('Continue');
    });
    await act(async () => {
      alertCall(alert, 4).press('Erase');
    });
    expect(fake.session.eraseDevice).toHaveBeenCalledTimes(1);
    // Offline erase: the device is still listed on the server, and the user is told how to remove it.
    expect(screen.getByTestId('toast')).toHaveTextContent(/could not be signed out on the server/);
  });
});

describe('Change password (§5.3)', () => {
  function setUp() {
    const fake = createFakeServices({ status: 'ready', user: TEST_USER });
    renderScreen('ChangePassword', ChangePasswordScreen, fake.services);
    return fake;
  }

  async function submit(current: string, next: string, repeat: string) {
    fireEvent.changeText(screen.getByTestId('change-password-current'), current);
    fireEvent.changeText(screen.getByTestId('change-password-new'), next);
    fireEvent.changeText(screen.getByTestId('change-password-repeat'), repeat);
    await act(async () => {
      fireEvent.press(screen.getByTestId('change-password-submit'));
    });
  }

  it('warns that other devices are signed out and lose undelivered messages', async () => {
    setUp();
    expect(await screen.findByTestId('change-password-warning')).toHaveTextContent(
      /signs out all your other devices\. Messages that have not reached them yet are lost/,
    );
  });

  it('checks the fields, explains a wrong current password, and goes back after success', async () => {
    const fake = setUp();
    await screen.findByTestId('change-password-current');
    await submit('old-password', 'new-password', 'other-password');
    expect(screen.getByText('The new passwords do not match.')).toBeOnTheScreen();
    expect(fake.session.api.changePassword).not.toHaveBeenCalled();

    fake.session.api.changePassword.mockRejectedValueOnce(new ApiError({ status: 401, code: 'invalid_credentials', message: 'x' }));
    await submit('wrong-password', 'new-password', 'new-password');
    expect(screen.getByTestId('change-password-error')).toHaveTextContent('Your current password is wrong.');

    await submit('old-password', 'new-password', 'new-password');
    expect(fake.session.api.changePassword).toHaveBeenLastCalledWith('old-password', 'new-password');
    expect(await screen.findByTestId('stub-Main')).toBeOnTheScreen();
    expect(screen.getByTestId('toast')).toHaveTextContent('Password changed. Your other devices were signed out.');
  });
});
