import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base32crockford } from '@scure/base';

import { fromBase64Exact, fromBase64, toBase64, utf8Decode, utf8Encode } from './encoding';
import { CryptoError } from './errors';
import { isUuidV4, randomBytes } from './random';

/** Backup encryption (protocol §4.3) and the backup file envelope (protocol §10). */

export const RECOVERY_KEY_BYTES = 15; // 120 bits = 24 Crockford base32 characters
const RECOVERY_KEY_CHARS = 24;
const SALT_LENGTH = 16;
const NONCE_LENGTH = 24;
const CROCKFORD_ALPHABET = /^[0-9A-HJKMNP-TV-Z]+$/;

export function generateRecoveryKey(): Uint8Array {
  return randomBytes(RECOVERY_KEY_BYTES);
}

/** `7K3M-Q9TD-...`: 24 uppercase Crockford characters in 6 groups of 4. */
export function formatRecoveryKey(key: Uint8Array): string {
  if (key.length !== RECOVERY_KEY_BYTES) throw new CryptoError('invalid_recovery_key', 'Recovery key must be 15 bytes');
  const chars = base32crockford.encode(key);
  return chars.match(/.{4}/g)!.join('-');
}

/**
 * Accepts what a person types: case-insensitive, `-` and whitespace ignored, O→0 and I/L→1.
 * Anything else that is not exactly 24 Crockford characters is rejected.
 */
export function parseRecoveryKey(input: string): Uint8Array {
  const normalized = input
    .toUpperCase()
    .replace(/[-\s]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (normalized.length !== RECOVERY_KEY_CHARS || !CROCKFORD_ALPHABET.test(normalized)) {
    throw new CryptoError('invalid_recovery_key', 'A recovery key has 24 characters (0-9, A-Z without I, L, O, U)');
  }
  try {
    return base32crockford.decode(normalized);
  } catch (cause) {
    throw new CryptoError('invalid_recovery_key', 'Invalid recovery key', { cause });
  }
}

/** Last group of the formatted key, which the user re-types to confirm they saved it (§4.3). */
export function recoveryKeyConfirmationGroup(key: Uint8Array): string {
  return formatRecoveryKey(key).slice(-4);
}

export interface BackupFile {
  format: 'fixes-backup';
  version: 1;
  user_id: string;
  created_at: string;
  kdf: { name: 'hkdf-sha256'; salt: string };
  cipher: 'xchacha20poly1305';
  nonce: string;
  ciphertext: string;
}

function deriveBackupKey(recoveryKey: Uint8Array, salt: Uint8Array): Uint8Array {
  if (recoveryKey.length !== RECOVERY_KEY_BYTES) throw new CryptoError('invalid_recovery_key', 'Recovery key must be 15 bytes');
  return hkdf(sha256, recoveryKey, salt, utf8Encode('fixes/v1/backup'), 32);
}

function backupAad(userId: string, createdAt: string, saltB64: string): Uint8Array {
  return utf8Encode(`fixes-backup/v1|${userId}|${createdAt}|${saltB64}`);
}

const ISO_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function encryptBackup(params: {
  userId: string;
  /** ISO 8601 UTC with milliseconds, e.g. `new Date(now).toISOString()`. */
  createdAt: string;
  body: unknown;
  recoveryKey: Uint8Array;
}): BackupFile {
  if (!isUuidV4(params.userId)) throw new CryptoError('invalid_backup', 'Backup user id must be a UUIDv4');
  if (!ISO_UTC_MS.test(params.createdAt)) throw new CryptoError('invalid_backup', 'created_at must be ISO 8601 UTC');
  const json = JSON.stringify(params.body);
  if (typeof json !== 'string') throw new CryptoError('invalid_payload', 'Backup body is not JSON-serialisable');
  const salt = randomBytes(SALT_LENGTH);
  const saltB64 = toBase64(salt);
  const nonce = randomBytes(NONCE_LENGTH);
  const key = deriveBackupKey(params.recoveryKey, salt);
  const ciphertext = xchacha20poly1305(key, nonce, backupAad(params.userId, params.createdAt, saltB64)).encrypt(
    utf8Encode(json),
  );
  return {
    format: 'fixes-backup',
    version: 1,
    user_id: params.userId,
    created_at: params.createdAt,
    kdf: { name: 'hkdf-sha256', salt: saltB64 },
    cipher: 'xchacha20poly1305',
    nonce: toBase64(nonce),
    ciphertext: toBase64(ciphertext),
  };
}

/** Checks the plaintext header of a backup file (format, version, cipher, kdf) before asking for the key. */
export function parseBackupFile(value: unknown): BackupFile {
  if (typeof value !== 'object' || value === null) throw new CryptoError('invalid_backup', 'Not a Fixes backup');
  const f = value as Record<string, unknown>;
  if (f.format !== 'fixes-backup') throw new CryptoError('invalid_backup', 'Not a Fixes backup');
  if (f.version !== 1) throw new CryptoError('unsupported_backup', 'Unsupported backup version');
  if (f.cipher !== 'xchacha20poly1305') throw new CryptoError('unsupported_backup', 'Unsupported backup cipher');
  const kdf = f.kdf as Record<string, unknown> | null | undefined;
  if (typeof kdf !== 'object' || kdf === null || kdf.name !== 'hkdf-sha256' || typeof kdf.salt !== 'string') {
    throw new CryptoError('unsupported_backup', 'Unsupported backup key derivation');
  }
  if (!isUuidV4(f.user_id)) throw new CryptoError('invalid_backup', 'Invalid backup user id');
  if (typeof f.created_at !== 'string' || !ISO_UTC_MS.test(f.created_at)) {
    throw new CryptoError('invalid_backup', 'Invalid backup timestamp');
  }
  if (typeof f.nonce !== 'string' || typeof f.ciphertext !== 'string') {
    throw new CryptoError('invalid_backup', 'Backup is missing its ciphertext');
  }
  fromBase64Exact(kdf.salt, SALT_LENGTH);
  fromBase64Exact(f.nonce, NONCE_LENGTH);
  return {
    format: 'fixes-backup',
    version: 1,
    user_id: f.user_id,
    created_at: f.created_at,
    kdf: { name: 'hkdf-sha256', salt: kdf.salt },
    cipher: 'xchacha20poly1305',
    nonce: f.nonce,
    ciphertext: f.ciphertext,
  };
}

/**
 * Decrypts a backup for `expectedUserId`. A wrong recovery key and a tampered file are
 * indistinguishable by design and both raise `decrypt_failed`; nothing is returned in that case.
 */
export function decryptBackup(value: unknown, recoveryKey: Uint8Array, expectedUserId: string): unknown {
  const file = parseBackupFile(value);
  if (file.user_id !== expectedUserId) {
    throw new CryptoError('backup_user_mismatch', 'This backup belongs to a different account');
  }
  const salt = fromBase64Exact(file.kdf.salt, SALT_LENGTH);
  const nonce = fromBase64Exact(file.nonce, NONCE_LENGTH);
  const ciphertext = fromBase64(file.ciphertext);
  const key = deriveBackupKey(recoveryKey, salt);
  let plaintext: Uint8Array;
  try {
    plaintext = xchacha20poly1305(key, nonce, backupAad(file.user_id, file.created_at, file.kdf.salt)).decrypt(
      ciphertext,
    );
  } catch (cause) {
    throw new CryptoError('decrypt_failed', 'Wrong recovery key or damaged backup', { cause });
  }
  try {
    return JSON.parse(utf8Decode(plaintext));
  } catch (cause) {
    throw new CryptoError('invalid_backup', 'Backup content is not valid JSON', { cause });
  }
}
