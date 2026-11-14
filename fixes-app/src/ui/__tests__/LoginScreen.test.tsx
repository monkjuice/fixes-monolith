import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { ApiError, NetworkError } from '../../core/api/errors';
import { FixesApp } from '../FixesApp';
import { createFakeServices } from './support/fakeServices';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function renderLogin(initial = {}) {
  const fake = createFakeServices({ status: 'signedOut', ...initial });
  render(<FixesApp services={fake.services} />);
  await screen.findByTestId('login-submit');
  return fake;
}

function fillIn(username: string, password: string) {
  fireEvent.changeText(screen.getByTestId('login-username'), username);
  fireEvent.changeText(screen.getByTestId('login-password'), password);
}

describe('LoginScreen', () => {
  it('validates the form before calling the server', async () => {
    const fake = await renderLogin();

    fireEvent.press(screen.getByTestId('login-submit'));
    expect(screen.getByTestId('login-error')).toHaveTextContent('Enter your username and password.');

    fillIn('al', 'long enough password');
    fireEvent.press(screen.getByTestId('login-submit'));
    expect(screen.getByTestId('login-error')).toHaveTextContent('Invalid username/password');

    fillIn('alice', 'short');
    fireEvent.press(screen.getByTestId('login-submit'));
    expect(screen.getByTestId('login-error')).toHaveTextContent('Invalid username/password');
    // Legacy behaviour: the password is cleared after a failed attempt.
    expect(screen.getByTestId('login-password').props.value).toBe('');

    expect(fake.session.login).not.toHaveBeenCalled();
  });

  it('shows "Loading.." and disables the button while logging in, then reports wrong credentials', async () => {
    const fake = await renderLogin();
    const pending = deferred();
    fake.session.login.mockReturnValueOnce(pending.promise);

    fillIn(' alice ', 'correct horse');
    fireEvent.press(screen.getByTestId('login-submit'));

    const button = screen.getByTestId('login-submit');
    expect(button).toBeDisabled();
    expect(screen.getByText('Loading..')).toBeOnTheScreen();
    expect(screen.queryByText('Login')).toBeNull();
    fireEvent.press(button);
    expect(fake.session.login).toHaveBeenCalledTimes(1);
    expect(fake.session.login).toHaveBeenCalledWith('alice', 'correct horse');

    await act(async () => {
      pending.reject(new ApiError({ status: 401, code: 'invalid_credentials', message: 'Wrong' }));
    });
    expect(screen.getByTestId('login-error')).toHaveTextContent('Invalid username/password');
    expect(screen.getByTestId('login-submit')).toBeEnabled();
    expect(screen.getByText('Login')).toBeOnTheScreen();
    expect(screen.getByTestId('login-password').props.value).toBe('');
  });

  it('keeps the legacy "No internet connection" error', async () => {
    const fake = await renderLogin();
    fake.session.login.mockRejectedValueOnce(new NetworkError('offline', 'Network request failed'));
    fillIn('alice', 'correct horse');
    await act(async () => {
      fireEvent.press(screen.getByTestId('login-submit'));
    });
    expect(screen.getByTestId('login-error')).toHaveTextContent('No internet connection');
  });

  it('explains a too_many_devices refusal and rate limits', async () => {
    const fake = await renderLogin();
    fake.session.login
      .mockRejectedValueOnce(new ApiError({ status: 409, code: 'too_many_devices', message: 'x' }))
      .mockRejectedValueOnce(new ApiError({ status: 429, code: 'rate_limited', message: 'x', retryAfter: 30 }));
    fillIn('alice', 'correct horse');
    await act(async () => {
      fireEvent.press(screen.getByTestId('login-submit'));
    });
    expect(screen.getByTestId('login-error')).toHaveTextContent(/already has 10 active devices/);
    fillIn('alice', 'correct horse');
    await act(async () => {
      fireEvent.press(screen.getByTestId('login-submit'));
    });
    expect(screen.getByTestId('login-error')).toHaveTextContent('Too many attempts. Try again in 30 seconds.');
  });

  it('says "This device was signed out" after a revocation, not after a normal logout', async () => {
    const fake = await renderLogin({ signedOutReason: 'device_revoked' });
    expect(screen.getByTestId('signed-out-notice')).toHaveTextContent(/This device was signed out/);
    await act(async () => {
      fake.setSession({ signedOutReason: 'logout' });
    });
    expect(screen.queryByTestId('signed-out-notice')).toBeNull();
  });

  it('opens "Create account"', async () => {
    await renderLogin();
    fireEvent.press(screen.getByTestId('login-register'));
    expect(await screen.findByTestId('register-submit')).toBeOnTheScreen();
  });
});
