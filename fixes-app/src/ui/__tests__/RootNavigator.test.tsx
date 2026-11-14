import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { ApiError } from '../../core/api/errors';
import { FixesApp } from '../FixesApp';
import { createFakeServices, TEST_QR, TEST_USER } from './support/fakeServices';

const DEVICE = {
  id: '0b3c5d7e-1f2a-4b6c-8d9e-0f1a2b3c4d5e',
  name: 'Test phone',
  public_key: 'AAAA',
  certificate: null,
  created_at: '2026-01-01T00:00:00.000Z',
  last_seen_at: '2026-01-01T00:00:00.000Z',
  current: true,
};

describe('root navigation by session status (§9 step 1)', () => {
  it('switches splash → login → link this device → inbox → login', async () => {
    const fake = createFakeServices({ status: 'loading' });
    render(<FixesApp services={fake.services} />);
    expect(await screen.findByLabelText('Loading')).toBeOnTheScreen();
    expect(screen.queryByTestId('login-submit')).toBeNull();

    await act(async () => {
      fake.setSession({ status: 'signedOut' });
    });
    expect(await screen.findByTestId('login-submit')).toBeOnTheScreen();

    await act(async () => {
      fake.setSession({ status: 'needsLink', user: TEST_USER, device: DEVICE });
    });
    expect(await screen.findByText('Link this device', { exact: false })).toBeOnTheScreen();
    expect(await screen.findByTestId('link-qr')).toBeOnTheScreen();
    expect(fake.messaging.createLinkQr).toHaveBeenCalled();
    expect(fake.messaging.incomingLink.get().qr).toBe(TEST_QR);
    expect(screen.queryByTestId('login-submit')).toBeNull();

    await act(async () => {
      fake.setSession({ status: 'ready', device: { ...DEVICE, certificate: 'cert' } });
    });
    expect(await screen.findByTestId('inbox-empty')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'New conversation' })).toBeOnTheScreen();
    // §13: the inbox refreshes peer profiles when it gains focus.
    expect(fake.messaging.refreshPeers).toHaveBeenCalled();
    expect(screen.queryByTestId('link-qr')).toBeNull();

    await act(async () => {
      fake.setSession({ status: 'signedOut', user: null, device: null, signedOutReason: 'device_revoked' });
    });
    expect(await screen.findByTestId('signed-out-notice')).toBeOnTheScreen();
    expect(screen.queryByTestId('inbox-empty')).toBeNull();
  });

  it('shows the offline state while loading and retries on request', async () => {
    const fake = createFakeServices({ status: 'loading', offline: true });
    render(<FixesApp services={fake.services} />);
    expect(await screen.findByText('No internet connection — retrying…')).toBeOnTheScreen();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Retry now' }));
    });
    expect(fake.session.retry).toHaveBeenCalledTimes(1);
  });

  it('offers the identity reset on "Link this device", with a warning and the password', async () => {
    const fake = createFakeServices({ status: 'needsLink', user: TEST_USER, device: DEVICE });
    render(<FixesApp services={fake.services} />);
    fireEvent.press(await screen.findByTestId('reset-identity-open'));
    expect(screen.getByText('• Your contacts will see that your safety code changed.')).toBeOnTheScreen();

    fireEvent.press(screen.getByTestId('reset-identity-submit'));
    expect(screen.getByTestId('reset-identity-error')).toHaveTextContent('Enter your password.');
    expect(fake.session.resetIdentity).not.toHaveBeenCalled();

    fake.session.resetIdentity.mockRejectedValueOnce(new ApiError({ status: 401, code: 'invalid_credentials', message: 'x' }));
    fireEvent.changeText(screen.getByTestId('reset-identity-password'), 'not my password');
    await act(async () => {
      fireEvent.press(screen.getByTestId('reset-identity-submit'));
    });
    expect(fake.session.resetIdentity).toHaveBeenCalledWith('not my password');
    expect(screen.getByTestId('reset-identity-error')).toHaveTextContent('Wrong password.');
  });

  it('shows history transfer progress and offers a new code after expiry', async () => {
    const fake = createFakeServices({ status: 'needsLink', user: TEST_USER, device: DEVICE });
    render(<FixesApp services={fake.services} />);
    await screen.findByTestId('link-qr');
    await act(async () => {
      fake.messaging.incomingLink.update({ phase: 'receiving', linkReceived: true, receivedChunks: 1, totalChunks: 3 });
    });
    expect(screen.getByText('Linked. Receiving your history… 1 of 3')).toBeOnTheScreen();

    await act(async () => {
      fake.messaging.incomingLink.update({ phase: 'expired', qr: null });
    });
    expect(screen.getByText('Transfer incomplete, retry.')).toBeOnTheScreen();
    const calls = fake.messaging.createLinkQr.mock.calls.length;
    await act(async () => {
      fireEvent.press(screen.getByTestId('link-new-code'));
    });
    expect(fake.messaging.createLinkQr.mock.calls.length).toBe(calls + 1);
    expect(await screen.findByTestId('link-qr')).toBeOnTheScreen();
  });
});
