import { isValidPassword } from '../../core/utils/validation';

export const PASSWORD_RULE = 'Passwords have 8 to 128 characters.';

export interface PasswordChangeErrors {
  current: string | null;
  next: string | null;
  repeat: string | null;
}

export const NO_PASSWORD_ERRORS: PasswordChangeErrors = { current: null, next: null, repeat: null };

/** Field checks before `POST /v1/auth/password` (§3: 8–128 characters). */
export function validatePasswordChange(current: string, next: string, repeat: string): PasswordChangeErrors {
  return {
    current: current.length === 0 ? 'Enter your current password.' : null,
    next: isValidPassword(next) ? null : PASSWORD_RULE,
    repeat: repeat === next ? null : 'The new passwords do not match.',
  };
}

export function hasPasswordErrors(errors: PasswordChangeErrors): boolean {
  return errors.current !== null || errors.next !== null || errors.repeat !== null;
}
