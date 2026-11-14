import type { SignedOutCause } from '../../../core/session/sessionManager';
import type { ErrorMessages } from '../../presentation/errors';

/** Legacy LoginViewModel text for any credential problem. */
export const INVALID_CREDENTIALS = 'Invalid username/password';

export const LOGIN_ERRORS: ErrorMessages = {
  invalid_credentials: INVALID_CREDENTIALS,
  validation_error: INVALID_CREDENTIALS,
  too_many_devices:
    'This account already has 10 active devices. Log out on one of them, or remove one under Settings → Devices on another device, then try again.',
  // A device key collision or a rejected key is a one-in-a-lifetime event: a new attempt uses a new key.
  device_key_in_use: 'Please try again.',
  invalid_public_key: 'Please try again.',
};

export const REGISTER_ERRORS: ErrorMessages = {
  // Legacy RegisterViewModel text.
  username_taken: 'Username already in use',
  validation_error: 'Check your username and password.',
};

/** §6: why the previous session ended, when the user did not end it. */
export function signedOutNotice(reason: SignedOutCause | null): string | null {
  switch (reason) {
    case 'device_revoked':
    case 'invalid_refresh_token':
      return 'This device was signed out. Log in again to continue; your messages on this phone are kept.';
    case 'erased':
      return 'This device was erased.';
    default:
      return null;
  }
}
