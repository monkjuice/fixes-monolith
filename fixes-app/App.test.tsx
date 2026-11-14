import { act, render, screen } from '@testing-library/react-native';

import App from './App';
import { getAppServices, type AppServices } from './src/platform/services';
import { createFakeServices } from './src/ui/__tests__/support/fakeServices';

jest.mock('./src/platform/services', () => ({ getAppServices: jest.fn() }));

const mockedGetAppServices = jest.mocked(getAppServices);

describe('App', () => {
  afterEach(() => jest.restoreAllMocks());

  it('starts the session with the app services and follows its status', async () => {
    const fake = createFakeServices();
    mockedGetAppServices.mockReturnValue(fake.services as unknown as AppServices);
    render(<App />);
    expect(fake.session.start).toHaveBeenCalledTimes(1);
    expect(await screen.findByLabelText('Loading')).toBeOnTheScreen();
    await act(async () => {
      fake.setSession({ status: 'signedOut' });
    });
    expect(await screen.findByTestId('login-submit')).toBeOnTheScreen();
  });

  it('shows why it cannot start when the configuration is invalid', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockedGetAppServices.mockImplementation(() => {
      throw new Error('EXPO_PUBLIC_API_URL is not set');
    });
    render(<App />);
    expect(screen.getByText('EXPO_PUBLIC_API_URL is not set')).toBeOnTheScreen();
    expect(consoleError).toHaveBeenCalled();
  });
});
