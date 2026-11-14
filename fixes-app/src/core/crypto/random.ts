import { CryptoError } from './errors';
import { bytesEqual, isAllZero, toHex } from './encoding';

/**
 * Every random value (keys, nonces, salts, ids, transfer secrets, even backoff jitter) comes from
 * crypto.getRandomValues — never Math.random (protocol §2). On React Native the global is
 * installed by `react-native-get-random-values`, imported first in index.ts.
 */

// getRandomValues rejects requests above 65 536 bytes.
const MAX_CHUNK = 65536;

function getRandomValuesFn(): (array: Uint8Array) => Uint8Array {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new CryptoError('random_unavailable', 'crypto.getRandomValues is not available');
  }
  return c.getRandomValues.bind(c);
}

export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 0) {
    throw new CryptoError('random_unavailable', 'Invalid random length');
  }
  const getRandomValues = getRandomValuesFn();
  const out = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += MAX_CHUNK) {
    getRandomValues(out.subarray(offset, Math.min(length, offset + MAX_CHUNK)));
  }
  return out;
}

/** Uniform float in [0, 1) from 52 random bits. */
export function randomFloat(): number {
  const b = randomBytes(7);
  // 52 bits: 4 bits from b[0] and 48 from b[1..6].
  let value = b[0] & 0x0f;
  for (let i = 1; i < 7; i++) value = value * 256 + b[i];
  return value / 2 ** 52;
}

/** Lowercase RFC 4122 version 4 UUID (protocol §3). */
export function uuidv4(): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Strict check for the lowercase UUIDv4 ids used by the protocol. */
export function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

/**
 * Startup self-test (protocol §2): 32 random bytes must be obtainable and must not look broken
 * (all zero, or identical on two draws). Throws so the app refuses to run without a CSPRNG.
 */
export function selfTestRandom(): void {
  const a = randomBytes(32);
  const b = randomBytes(32);
  if (a.length !== 32 || isAllZero(a) || isAllZero(b) || bytesEqual(a, b)) {
    throw new CryptoError('random_unavailable', 'The random number generator failed its self-test');
  }
}
