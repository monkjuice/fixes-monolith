import { x25519 } from '@noble/curves/ed25519.js';

import { bytesEqual } from './encoding';
import { CryptoError } from './errors';
import { randomBytes } from './random';

/** Per-login device key (protocol §4.1): X25519. The secret never leaves the device. */
export interface DeviceKeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export const X25519_KEY_LENGTH = 32;

export function generateDeviceKeyPair(): DeviceKeyPair {
  const secretKey = randomBytes(X25519_KEY_LENGTH);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export function deviceKeyPairMatches(secretKey: Uint8Array, publicKey: Uint8Array): boolean {
  if (secretKey.length !== X25519_KEY_LENGTH || publicKey.length !== X25519_KEY_LENGTH) return false;
  return bytesEqual(x25519.getPublicKey(secretKey), publicKey);
}

export function assertX25519Key(key: Uint8Array, what: string): void {
  if (!(key instanceof Uint8Array) || key.length !== X25519_KEY_LENGTH) {
    throw new CryptoError('invalid_key', `${what} must be a 32-byte X25519 key`);
  }
}
