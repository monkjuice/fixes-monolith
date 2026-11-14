/** Client-side checks of user input that mirror the server rules (protocol §3, §5.3). */

export class InputValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InputValidationError';
    this.field = field;
  }
}

const USERNAME = /^[A-Za-z0-9_]{3,30}$/;
const SEARCH_QUERY = /^[A-Za-z0-9_]{1,30}$/;

export function isValidUsername(value: string): boolean {
  return USERNAME.test(value);
}

/** Discover search input (§14): validated before calling `GET /v1/users?q=`. */
export function isValidSearchQuery(value: string): boolean {
  return SEARCH_QUERY.test(value);
}

/** 8–128 characters, counted as Unicode code points like the server does. */
export function isValidPassword(value: string): boolean {
  const length = [...value].length;
  return length >= 8 && length <= 128;
}

export function assertCredentials(username: string, password: string): void {
  if (!isValidUsername(username)) {
    throw new InputValidationError('username', 'Usernames have 3 to 30 letters, digits or underscores.');
  }
  if (!isValidPassword(password)) {
    throw new InputValidationError('password', 'Passwords have 8 to 128 characters.');
  }
}

/** Device names sent at login are 1–64 characters; longer platform names are truncated. */
export function normalizeDeviceName(name: string): string {
  const trimmed = [...name.trim()].slice(0, 64).join('');
  return trimmed.length > 0 ? trimmed : 'Phone';
}
