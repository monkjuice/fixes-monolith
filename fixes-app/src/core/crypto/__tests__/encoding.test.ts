import {
  bytesEqual,
  compareBytes,
  concatBytes,
  fromBase64,
  fromBase64Exact,
  fromBase64Url,
  fromHex,
  toBase64,
  toBase64Url,
  toHex,
  utf8Decode,
  utf8Encode,
} from '../encoding';
import { CryptoError } from '../errors';
import { randomBytes } from '../random';

describe('base64 (standard, padded)', () => {
  it('matches RFC 4648 test vectors', () => {
    const vectors: [string, string][] = [
      ['', ''],
      ['f', 'Zg=='],
      ['fo', 'Zm8='],
      ['foo', 'Zm9v'],
      ['foob', 'Zm9vYg=='],
      ['fooba', 'Zm9vYmE='],
      ['foobar', 'Zm9vYmFy'],
    ];
    for (const [plain, encoded] of vectors) {
      expect(toBase64(utf8Encode(plain))).toBe(encoded);
      expect(utf8Decode(fromBase64(encoded))).toBe(plain);
    }
  });

  it('uses + and / and round-trips random bytes', () => {
    expect(toBase64(Uint8Array.from([0xfb, 0xff]))).toBe('+/8=');
    const bytes = randomBytes(97);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it.each(['Zg', 'Zg=', 'Z g==', '-_8=', 'Zh=='])('rejects malformed or non-canonical input %p', (bad) => {
    expect(() => fromBase64(bad)).toThrow(CryptoError);
  });

  it('enforces exact decoded lengths', () => {
    const key = toBase64(new Uint8Array(32));
    expect(fromBase64Exact(key, 32)).toHaveLength(32);
    expect(() => fromBase64Exact(key, 24)).toThrow(/Expected 24 bytes/);
  });
});

describe('base64url (no padding)', () => {
  it('uses - and _ without padding', () => {
    expect(toBase64Url(Uint8Array.from([0xfb, 0xff]))).toBe('-_8');
    expect(fromBase64Url('-_8')).toEqual(Uint8Array.from([0xfb, 0xff]));
  });

  it('rejects padding and standard-alphabet characters', () => {
    expect(() => fromBase64Url('-_8=')).toThrow(CryptoError);
    expect(() => fromBase64Url('+/8')).toThrow(CryptoError);
  });

  it('round-trips a 32-byte key', () => {
    const key = randomBytes(32);
    const text = toBase64Url(key);
    expect(text).toHaveLength(43);
    expect(fromBase64Url(text)).toEqual(key);
  });
});

describe('utf8', () => {
  it('encodes ASCII, multi-byte and astral characters like TextEncoder', () => {
    const samples = ['hello', 'ñandú', '€', 'こんにちは', '😀 emoji', 'a\u0000b', ''];
    const encoder = new TextEncoder();
    for (const s of samples) {
      expect(utf8Encode(s)).toEqual(encoder.encode(s));
      expect(utf8Decode(encoder.encode(s))).toBe(s);
    }
  });

  it('decodes long strings in chunks', () => {
    const long = 'é'.repeat(20000);
    expect(utf8Decode(utf8Encode(long))).toBe(long);
  });

  it.each([
    ['truncated sequence', [0xe2, 0x82]],
    ['lone continuation byte', [0x80]],
    ['overlong encoding', [0xc0, 0xaf]],
    ['encoded surrogate', [0xed, 0xa0, 0x80]],
    ['above U+10FFFF', [0xf4, 0x90, 0x80, 0x80]],
  ])('rejects %s', (_name, bytes) => {
    expect(() => utf8Decode(Uint8Array.from(bytes))).toThrow(CryptoError);
  });

  it('rejects unpaired surrogates when encoding', () => {
    expect(() => utf8Encode('\ud800')).toThrow(CryptoError);
    expect(() => utf8Encode('\udc00x')).toThrow(CryptoError);
  });
});

describe('byte helpers', () => {
  it('hex round trip is lowercase', () => {
    expect(toHex(Uint8Array.from([0, 171, 255]))).toBe('00abff');
    expect(fromHex('00abff')).toEqual(Uint8Array.from([0, 171, 255]));
    expect(() => fromHex('zz')).toThrow(CryptoError);
  });

  it('concatenates, compares and orders', () => {
    expect(concatBytes(Uint8Array.from([1]), Uint8Array.from([2, 3]))).toEqual(Uint8Array.from([1, 2, 3]));
    expect(bytesEqual(Uint8Array.from([1, 2]), Uint8Array.from([1, 2]))).toBe(true);
    expect(bytesEqual(Uint8Array.from([1, 2]), Uint8Array.from([1, 3]))).toBe(false);
    expect(bytesEqual(Uint8Array.from([1]), Uint8Array.from([1, 0]))).toBe(false);
    expect(compareBytes(Uint8Array.from([1, 2]), Uint8Array.from([1, 3]))).toBeLessThan(0);
    expect(compareBytes(Uint8Array.from([9]), Uint8Array.from([1, 0]))).toBeGreaterThan(0);
  });
});
