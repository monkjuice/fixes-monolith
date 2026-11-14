import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Alert, type AlertButton } from 'react-native';

import { NetworkError } from '../../core/api/errors';
import { FixesApp } from '../FixesApp';
import { UNDRAINED_TEXT } from '../hooks/useLogout';
import { createFakeServices, TEST_USER } from './support/fakeServices';

async function openProfile() {
  const fake = createFakeServices({ status: 'ready', user: TEST_USER });
  render(<FixesApp services={fake.services} />);
  await screen.findByTestId('inbox-list');
  fireEvent.press(screen.getByRole('button', { name: /Profile/ }));
  await screen.findByTestId('profile-logout');
  return fake;
}

describe('Log Out (§13)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('asks before leaving unsent items behind, then logs out with force', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const fake = await openProfile();
    fake.messaging.logout.mockResolvedValueOnce({ status: 'unsent', remaining: 2 });

    await act(async () => {
      fireEvent.press(screen.getByTestId('profile-logout'));
    });
    expect(fake.messaging.logout).toHaveBeenCalledWith({ force: false });
    expect(alert).toHaveBeenCalledTimes(1);
    const [title, text, buttons] = alert.mock.calls[0] as [string, string, AlertButton[]];
    expect(title).toBe('Unsent messages');
    expect(text).toMatch(/^2 messages or receipts could not be sent yet/);

    await act(async () => {
      buttons.find((b) => b.text === 'Log out')?.onPress?.();
    });
    expect(fake.messaging.logout).toHaveBeenLastCalledWith({ force: true });
  });

  it('on the startup error screen, asks before messages waiting on the server are lost, then logs out with force', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const fake = createFakeServices({ status: 'loading', user: TEST_USER, error: 'Something went wrong' });
    fake.messaging.logout.mockResolvedValueOnce({ status: 'undrained' });
    render(<FixesApp services={fake.services} />);
    const logOut = await screen.findByRole('button', { name: 'Log Out' });

    await act(async () => {
      fireEvent.press(logOut);
    });
    expect(fake.messaging.logout).toHaveBeenCalledWith({ force: false });
    expect(alert).toHaveBeenCalledTimes(1);
    const [title, text, buttons] = alert.mock.calls[0] as [string, string, AlertButton[]];
    expect(title).toBe('Messages not received');
    expect(text).toBe(UNDRAINED_TEXT);
    await act(async () => {
      buttons.find((b) => b.text === 'Log out')?.onPress?.();
    });
    expect(fake.messaging.logout).toHaveBeenLastCalledWith({ force: true });
  });

  it('explains that logging out needs a connection', async () => {
    const fake = await openProfile();
    fake.messaging.logout.mockRejectedValueOnce(new NetworkError('offline', 'Network request failed'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('profile-logout'));
    });
    expect(screen.getByText('No internet connection. Logging out needs a connection.')).toBeOnTheScreen();
  });
});
