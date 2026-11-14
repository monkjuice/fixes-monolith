import { sha256 } from '@noble/hashes/sha2.js';

import { concatBytes, utf8Encode } from '../encoding';
import { generateIdentityKeyPair } from '../identity';
import { safetyCode, safetyCodeGroups } from '../safetyCode';

describe('safety code (§4.4)', () => {
  it('is symmetric: both users see the same code', () => {
    const a = generateIdentityKeyPair().publicKey;
    const b = generateIdentityKeyPair().publicKey;
    expect(safetyCode(a, b)).toBe(safetyCode(b, a));
  });

  it('is stable and has 12 groups of 5 digits', () => {
    const a = generateIdentityKeyPair().publicKey;
    const b = generateIdentityKeyPair().publicKey;
    const groups = safetyCodeGroups(a, b);
    expect(groups).toHaveLength(12);
    groups.forEach((g) => expect(g).toMatch(/^\d{5}$/));
    expect(safetyCodeGroups(a, b)).toEqual(groups);
  });

  it('follows the documented construction with byte-wise key ordering', () => {
    const low = new Uint8Array(32).fill(1);
    const high = new Uint8Array(32).fill(2);
    const h = sha256(concatBytes(utf8Encode('fixes/v1/safety'), low, high));
    const expected = Array.from({ length: 12 }, (_, i) => String((h[2 * i] << 8) | h[2 * i + 1]).padStart(5, '0'));
    expect(safetyCodeGroups(high, low)).toEqual(expected);
    expect(safetyCode(low, high)).toBe(expected.join(' '));
  });

  it('changes when either key changes', () => {
    const a = generateIdentityKeyPair().publicKey;
    const b = generateIdentityKeyPair().publicKey;
    const c = generateIdentityKeyPair().publicKey;
    expect(safetyCode(a, b)).not.toBe(safetyCode(a, c));
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => safetyCode(new Uint8Array(31), new Uint8Array(32))).toThrow();
  });
});
