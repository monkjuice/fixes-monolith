import {
  assertCredentials,
  InputValidationError,
  isValidPassword,
  isValidSearchQuery,
  isValidUsername,
  normalizeDeviceName,
} from '../validation';

describe('input validation (§3, §14)', () => {
  it('usernames: 3–30 of [A-Za-z0-9_]', () => {
    expect(isValidUsername('abc')).toBe(true);
    expect(isValidUsername('A_b_9'.padEnd(30, 'x'))).toBe(true);
    expect(isValidUsername('ab')).toBe(false);
    expect(isValidUsername('a'.repeat(31))).toBe(false);
    expect(isValidUsername('bad-name')).toBe(false);
    expect(isValidUsername('ñandu')).toBe(false);
  });

  it('search queries: 1–30 of [A-Za-z0-9_]', () => {
    expect(isValidSearchQuery('a')).toBe(true);
    expect(isValidSearchQuery('')).toBe(false);
    expect(isValidSearchQuery('a b')).toBe(false);
    expect(isValidSearchQuery('.*')).toBe(false);
  });

  it('passwords: 8–128 code points', () => {
    expect(isValidPassword('12345678')).toBe(true);
    expect(isValidPassword('1234567')).toBe(false);
    expect(isValidPassword('x'.repeat(128))).toBe(true);
    expect(isValidPassword('x'.repeat(129))).toBe(false);
    // 8 emoji are 16 UTF-16 units but 8 characters.
    expect(isValidPassword('😀'.repeat(8))).toBe(true);
    // 128 emoji are 256 UTF-16 units but still 128 characters.
    expect(isValidPassword('😀'.repeat(128))).toBe(true);
    expect(isValidPassword('😀'.repeat(129))).toBe(false);
  });

  it('assertCredentials names the offending field', () => {
    expect(() => assertCredentials('ok_user', 'password1')).not.toThrow();
    expect(() => assertCredentials('x', 'password1')).toThrow(expect.objectContaining({ field: 'username' }));
    expect(() => assertCredentials('ok_user', 'short')).toThrow(InputValidationError);
  });

  it('device names are trimmed to 1–64 characters', () => {
    expect(normalizeDeviceName('  Pixel 9  ')).toBe('Pixel 9');
    expect(normalizeDeviceName('x'.repeat(100))).toHaveLength(64);
    expect(normalizeDeviceName('   ')).toBe('Phone');
  });
});
