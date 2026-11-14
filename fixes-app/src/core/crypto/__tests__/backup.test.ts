import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  decryptBackup,
  encryptBackup,
  formatRecoveryKey,
  generateRecoveryKey,
  parseBackupFile,
  parseRecoveryKey,
  recoveryKeyConfirmationGroup,
} from '../backup';
import { fromBase64, utf8Decode, utf8Encode } from '../encoding';
import { CryptoError } from '../errors';
import { uuidv4 } from '../random';

const userId = uuidv4();
const createdAt = '2026-11-13T10:20:30.123Z';
const body = {
  conversations: [{ peer_user_id: uuidv4(), peer_username: 'bob', peer_avatar_url: null }],
  messages: [],
  contact_identities: [],
};

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof CryptoError ? error.code : 'not-a-crypto-error';
  }
  return undefined;
}

describe('recovery key (§4.3)', () => {
  it('is 120 bits shown as 6 groups of 4 Crockford characters', () => {
    const key = generateRecoveryKey();
    expect(key).toHaveLength(15);
    const text = formatRecoveryKey(key);
    expect(text).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/);
    expect(parseRecoveryKey(text)).toEqual(key);
    expect(recoveryKeyConfirmationGroup(key)).toBe(text.slice(-4));
  });

  it('formats known bytes', () => {
    expect(formatRecoveryKey(new Uint8Array(15))).toBe('0000-0000-0000-0000-0000-0000');
    expect(formatRecoveryKey(new Uint8Array(15).fill(255))).toBe('ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ');
  });

  it('parses tolerantly: case, dashes, spaces, O→0 and I/L→1', () => {
    const key = generateRecoveryKey();
    const text = formatRecoveryKey(key);
    expect(parseRecoveryKey(text.toLowerCase())).toEqual(key);
    expect(parseRecoveryKey(text.replace(/-/g, ''))).toEqual(key);
    expect(parseRecoveryKey(` ${text.replace(/-/g, ' ')} `)).toEqual(key);
    expect(parseRecoveryKey('OOOO-OOOO-OOOO-OOOO-OOOO-OOOO')).toEqual(new Uint8Array(15));
    const ones = parseRecoveryKey('1111-1111-1111-1111-1111-1111');
    expect(parseRecoveryKey('IIII-LLLL-iiii-llll-1111-1111')).toEqual(ones);
  });

  it.each([
    ['too short', '0000-0000-0000-0000-0000-000'],
    ['too long', '0000-0000-0000-0000-0000-00000'],
    ['U is not Crockford', 'UUUU-0000-0000-0000-0000-0000'],
    ['punctuation', '0000.0000-0000-0000-0000-0000'],
    ['empty', ''],
  ])('rejects %s', (_name, input) => {
    expect(codeOf(() => parseRecoveryKey(input))).toBe('invalid_recovery_key');
  });
});

describe('backup encryption (§4.3, §10)', () => {
  it('round-trips with the right key', () => {
    const key = generateRecoveryKey();
    const file = encryptBackup({ userId, createdAt, body, recoveryKey: key });
    expect(file).toMatchObject({
      format: 'fixes-backup',
      version: 1,
      user_id: userId,
      created_at: createdAt,
      kdf: { name: 'hkdf-sha256' },
      cipher: 'xchacha20poly1305',
    });
    expect(fromBase64(file.kdf.salt)).toHaveLength(16);
    expect(fromBase64(file.nonce)).toHaveLength(24);
    // Survives serialisation to the .fixes file and back.
    expect(decryptBackup(JSON.parse(JSON.stringify(file)), key, userId)).toEqual(body);
    // Re-typed by the user in a different form.
    expect(decryptBackup(file, parseRecoveryKey(formatRecoveryKey(key).toLowerCase()), userId)).toEqual(body);
  });

  it('matches the spec construction (HKDF info, AAD with salt_b64)', () => {
    const key = generateRecoveryKey();
    const file = encryptBackup({ userId, createdAt, body, recoveryKey: key });
    const derived = hkdf(sha256, key, fromBase64(file.kdf.salt), utf8Encode('fixes/v1/backup'), 32);
    const aad = utf8Encode(`fixes-backup/v1|${userId}|${createdAt}|${file.kdf.salt}`);
    const plain = xchacha20poly1305(derived, fromBase64(file.nonce), aad).decrypt(fromBase64(file.ciphertext));
    expect(JSON.parse(utf8Decode(plain))).toEqual(body);
  });

  it('fails cleanly with a wrong recovery key', () => {
    const file = encryptBackup({ userId, createdAt, body, recoveryKey: generateRecoveryKey() });
    expect(codeOf(() => decryptBackup(file, generateRecoveryKey(), userId))).toBe('decrypt_failed');
  });

  it('detects tampering with authenticated header fields', () => {
    const key = generateRecoveryKey();
    const file = encryptBackup({ userId, createdAt, body, recoveryKey: key });
    expect(codeOf(() => decryptBackup({ ...file, created_at: '2026-11-13T10:20:31.123Z' }, key, userId))).toBe('decrypt_failed');
    const other = uuidv4();
    expect(codeOf(() => decryptBackup({ ...file, user_id: other }, key, other))).toBe('decrypt_failed');
  });

  it('refuses a backup of another account before decrypting', () => {
    const key = generateRecoveryKey();
    const file = encryptBackup({ userId, createdAt, body, recoveryKey: key });
    expect(codeOf(() => decryptBackup(file, key, uuidv4()))).toBe('backup_user_mismatch');
  });

  it('validates the file header', () => {
    const file = encryptBackup({ userId, createdAt, body, recoveryKey: generateRecoveryKey() });
    expect(codeOf(() => parseBackupFile({ ...file, format: 'other' }))).toBe('invalid_backup');
    expect(codeOf(() => parseBackupFile({ ...file, version: 2 }))).toBe('unsupported_backup');
    expect(codeOf(() => parseBackupFile({ ...file, cipher: 'aes' }))).toBe('unsupported_backup');
    expect(codeOf(() => parseBackupFile({ ...file, kdf: { name: 'pbkdf2', salt: file.kdf.salt } }))).toBe('unsupported_backup');
    expect(codeOf(() => parseBackupFile({ ...file, nonce: 'AAAA' }))).toBe('invalid_encoding');
    expect(codeOf(() => parseBackupFile('nope'))).toBe('invalid_backup');
  });
});
