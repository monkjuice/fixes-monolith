import { sha256 } from '@noble/hashes/sha2.js';

import { compareBytes, concatBytes, utf8Encode } from './encoding';
import { CryptoError } from './errors';

const PREFIX = utf8Encode('fixes/v1/safety');
const GROUPS = 12;

/**
 * Safety code for a contact pair (protocol §4.4): SHA-256("fixes/v1/safety" || k1 || k2) with
 * k1 ≤ k2 byte-wise, rendered as 12 groups of 5 digits. Symmetric, so both users see the same code.
 */
export function safetyCodeGroups(identityKeyA: Uint8Array, identityKeyB: Uint8Array): string[] {
  if (identityKeyA.length !== 32 || identityKeyB.length !== 32) {
    throw new CryptoError('invalid_key', 'Identity keys must be 32 bytes');
  }
  const [k1, k2] = compareBytes(identityKeyA, identityKeyB) <= 0 ? [identityKeyA, identityKeyB] : [identityKeyB, identityKeyA];
  const h = sha256(concatBytes(PREFIX, k1, k2));
  const groups: string[] = [];
  for (let i = 0; i < GROUPS; i++) {
    groups.push(String((h[2 * i] << 8) | h[2 * i + 1]).padStart(5, '0'));
  }
  return groups;
}

/** Display form: groups separated by spaces. */
export function safetyCode(identityKeyA: Uint8Array, identityKeyB: Uint8Array): string {
  return safetyCodeGroups(identityKeyA, identityKeyB).join(' ');
}
