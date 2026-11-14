import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { ApiError, NetworkError } from '../../core/api/errors';
import { FixesApp } from '../FixesApp';
import { createFakeServices } from './support/fakeServices';

async function renderRegister() {
  const fake = createFakeServices({ status: 'signedOut' });
  render(<FixesApp services={fake.services} />);
  fireEvent.press(await screen.findByTestId('login-register'));
  await screen.findByTestId('register-submit');
  return fake;
}

function fillIn(username: string, password: string) {
  fireEvent.changeText(screen.getByTestId('register-username'), username);
  fireEvent.changeText(screen.getByTestId('register-password'), password);
}

describe('RegisterScreen', () => {
  it('validates username and password locally (§3)', async () => {
    const fake = await renderRegister();
    fillIn('no spaces!', 'short');
    fireEvent.press(screen.getByTestId('register-submit'));
    expect(screen.getByText('Usernames have 3 to 30 letters, digits or underscores.')).toBeOnTheScreen();
    expect(screen.getByText('Passwords have 8 to 128 characters.')).toBeOnTheScreen();
    expect(fake.session.register).not.toHaveBeenCalled();
  });

  it('shows the welcome toast and then logs in automatically (§14)', async () => {
    const fake = await renderRegister();
    fillIn('Bob_1', 'a good password');
    await act(async () => {
      fireEvent.press(screen.getByTestId('register-submit'));
    });
    expect(fake.session.register).toHaveBeenCalledWith('Bob_1', 'a good password');
    expect(screen.getByTestId('toast')).toHaveTextContent('Welcome to Fixes Bob_1, please login to continue!');
    expect(fake.session.login).toHaveBeenCalledWith('Bob_1', 'a good password');
  });

  it('reports a taken username with the legacy text', async () => {
    const fake = await renderRegister();
    fake.session.register.mockRejectedValueOnce(new ApiError({ status: 409, code: 'username_taken', message: 'x' }));
    fillIn('bob', 'a good password');
    await act(async () => {
      fireEvent.press(screen.getByTestId('register-submit'));
    });
    expect(screen.getByTestId('register-error')).toHaveTextContent('Username already in use');
    expect(fake.session.login).not.toHaveBeenCalled();
    expect(screen.getByTestId('register-submit')).toBeEnabled();
  });

  it('keeps the account when the automatic login fails', async () => {
    const fake = await renderRegister();
    fake.session.login.mockRejectedValueOnce(new NetworkError('offline', 'Network request failed'));
    fillIn('bob', 'a good password');
    await act(async () => {
      fireEvent.press(screen.getByTestId('register-submit'));
    });
    expect(screen.getByTestId('register-error')).toHaveTextContent(
      'Your account was created, but logging in failed: No internet connection',
    );
  });
});
