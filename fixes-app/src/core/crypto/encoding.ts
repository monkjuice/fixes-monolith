import { base64, base64urlnopad, hex } from '@scure/base';

import { CryptoError } from './errors';

/**
 * Binary encodings used on the wire (protocol §3): standard base64 with padding in JSON, base64url
 * without padding in QR payloads. Decoders are strict (no whitespace, no missing padding, no
 * non-canonical trailing bits) so every value has exactly one accepted spelling.
 */

export function toBase64(bytes: Uint8Array): string {
  return base64.encode(bytes);
}

export function fromBase64(text: string): Uint8Array {
  try {
    return base64.decode(text);
  } catch (cause) {
    throw new CryptoError('invalid_encoding', 'Invalid base64 value', { cause });
  }
}

/** Decodes base64 and requires an exact decoded length (keys, nonces, signatures). */
export function fromBase64Exact(text: string, length: number): Uint8Array {
  const bytes = fromBase64(text);
  if (bytes.length !== length) {
    throw new CryptoError('invalid_encoding', `Expected ${length} bytes, got ${bytes.length}`);
  }
  return bytes;
}

export function toBase64Url(bytes: Uint8Array): string {
  return base64urlnopad.encode(bytes);
}

export function fromBase64Url(text: string): Uint8Array {
  try {
    return base64urlnopad.decode(text);
  } catch (cause) {
    throw new CryptoError('invalid_encoding', 'Invalid base64url value', { cause });
  }
}

export function toHex(bytes: Uint8Array): string {
  return hex.encode(bytes);
}

export function fromHex(text: string): Uint8Array {
  try {
    return hex.decode(text);
  } catch (cause) {
    throw new CryptoError('invalid_encoding', 'Invalid hex value', { cause });
  }
}

/**
 * UTF-8 is implemented here rather than with TextEncoder/TextDecoder because Hermes does not
 * guarantee a TextDecoder, and decoding must be strict (fatal on malformed input) for data that
 * arrives over the network.
 */
export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        throw new CryptoError('invalid_encoding', 'Unpaired surrogate in string');
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CryptoError('invalid_encoding', 'Unpaired surrogate in string');
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

export function utf8Decode(bytes: Uint8Array): string {
  const fail = (): never => {
    throw new CryptoError('invalid_encoding', 'Malformed UTF-8');
  };
  const parts: string[] = [];
  let chunk: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    let code: number;
    let need: number;
    let min: number;
    if (b0 < 0x80) {
      code = b0;
      need = 0;
      min = 0;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      code = b0 & 0x1f;
      need = 1;
      min = 0x80;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      code = b0 & 0x0f;
      need = 2;
      min = 0x800;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      code = b0 & 0x07;
      need = 3;
      min = 0x10000;
    } else {
      return fail();
    }
    for (let k = 1; k <= need; k++) {
      const b = bytes[i + k];
      if (b === undefined || (b & 0xc0) !== 0x80) fail();
      code = (code << 6) | (b & 0x3f);
    }
    if (code < min || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) fail();
    if (code >= 0x10000) {
      const v = code - 0x10000;
      chunk.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    } else {
      chunk.push(code);
    }
    // String.fromCharCode has an argument-count limit; flush in bounded chunks.
    if (chunk.length >= 4096) {
      parts.push(String.fromCharCode(...chunk));
      chunk = [];
    }
    i += need + 1;
  }
  parts.push(String.fromCharCode(...chunk));
  return parts.join('');
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/** Constant-time comparison for secrets and MAC-like values. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function isAllZero(bytes: Uint8Array): boolean {
  let acc = 0;
  for (let i = 0; i < bytes.length; i++) acc |= bytes[i];
  return acc === 0;
}

/** Byte-wise lexicographic comparison (used to order keys for safety codes). */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}
