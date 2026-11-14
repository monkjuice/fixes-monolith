import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { KeyboardAvoidingView, Platform } from 'react-native';

import { FixesApp } from '../FixesApp';
import { createFakeServices, TEST_USER } from './support/fakeServices';

/**
 * Android apps are edge-to-edge (Expo SDK 54+): the window is no longer resized for the keyboard, so
 * screens with text fields must pad themselves (KeyboardAvoidingScreen) or the keyboard covers the
 * fields and buttons at the bottom.
 */
describe('keyboard avoidance on Android', () => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', 'android');
  });
  afterEach(() => jest.restoreAllMocks());

  const behaviors = () => screen.UNSAFE_getAllByType(KeyboardAvoidingView).map((view) => view.props.behavior as unknown);

  it('pads Login and Register', async () => {
    const fake = createFakeServices({ status: 'signedOut' });
    render(<FixesApp services={fake.services} />);
    await screen.findByTestId('login-submit');
    expect(behaviors()).toEqual(['padding']);

    await act(async () => {
      fireEvent.press(screen.getByTestId('login-register'));
    });
    await screen.findByTestId('register-submit');
    // Login stays mounted below Register.
    expect(behaviors()).toEqual(['padding', 'padding']);
  });

  it('pads "Link this device", whose identity-reset password field is the last item', async () => {
    const fake = createFakeServices({ status: 'needsLink', user: TEST_USER });
    render(<FixesApp services={fake.services} />);
    await screen.findByRole('header', { name: 'Link this device' });
    expect(behaviors()).toEqual(['padding']);
  });
});
