import { CryptoError } from '../errors';
import { isUuidV4, randomBytes, randomFloat, selfTestRandom, uuidv4 } from '../random';

describe('random', () => {
  it('produces the requested number of bytes, including above the 64 KiB getRandomValues limit', () => {
    expect(randomBytes(0)).toHaveLength(0);
    expect(randomBytes(32)).toHaveLength(32);
    const big = randomBytes(70_000);
    expect(big).toHaveLength(70_000);
    // The tail beyond the first chunk must be filled too.
    expect(big.subarray(65_536).some((b) => b !== 0)).toBe(true);
  });

  it('generates lowercase UUIDv4 strings', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = uuidv4();
      expect(isUuidV4(id)).toBe(true);
      ids.add(id);
    }
    expect(ids.size).toBe(200);
  });

  it('validates UUIDv4 strictly', () => {
    expect(isUuidV4('3f2b8a8e-4c1d-4a8e-9f3e-2b7c1d0e9a11')).toBe(true);
    expect(isUuidV4('3F2B8A8E-4C1D-4A8E-9F3E-2B7C1D0E9A11')).toBe(false); // uppercase
    expect(isUuidV4('3f2b8a8e-4c1d-1a8e-9f3e-2b7c1d0e9a11')).toBe(false); // version 1
    expect(isUuidV4('3f2b8a8e-4c1d-4a8e-cf3e-2b7c1d0e9a11')).toBe(false); // bad variant
    expect(isUuidV4(42)).toBe(false);
  });

  it('randomFloat stays in [0, 1)', () => {
    for (let i = 0; i < 1000; i++) {
      const x = randomFloat();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('self-test passes with a working CSPRNG', () => {
    expect(() => selfTestRandom()).not.toThrow();
  });

  describe('with a broken or missing CSPRNG', () => {
    const original = globalThis.crypto;
    afterEach(() => {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true, writable: true });
    });

    it('self-test fails when getRandomValues returns zeros', () => {
      Object.defineProperty(globalThis, 'crypto', {
        value: { getRandomValues: (a: Uint8Array) => a },
        configurable: true,
        writable: true,
      });
      expect(() => selfTestRandom()).toThrow(CryptoError);
    });

    it('refuses to produce randomness without crypto.getRandomValues', () => {
      Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
      expect(() => randomBytes(8)).toThrow(/not available/);
    });
  });
});
