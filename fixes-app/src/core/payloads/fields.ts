import { fromBase64Exact } from '../crypto/encoding';
import { isUuidV4 } from '../crypto/random';

/**
 * Field validators for decrypted payloads (protocol §7). Payloads come from other devices, so every
 * field is checked for type, range and format before use; any violation is a PayloadError, which
 * the receive queue treats as a permanent failure (§13).
 */

export class PayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadError';
  }
}

export type Obj = Record<string, unknown>;

/** Largest timestamp accepted (year 9999), well inside Number.MAX_SAFE_INTEGER. */
export const MAX_TIMESTAMP_MS = 253_402_300_799_999;

export function asObject(value: unknown, what: string): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PayloadError(`${what} must be an object`);
  }
  return value as Obj;
}

export function uuidField(o: Obj, key: string): string {
  const value = o[key];
  if (!isUuidV4(value)) throw new PayloadError(`${key} must be a lowercase UUIDv4`);
  return value;
}

/** Integer milliseconds since the Unix epoch (§3). */
export function timestampField(o: Obj, key: string): number {
  const value = o[key];
  if (!isTimestamp(value)) throw new PayloadError(`${key} must be an integer timestamp in milliseconds`);
  return value;
}

export function nullableTimestampField(o: Obj, key: string): number | null {
  const value = o[key];
  return value === null ? null : timestampField(o, key);
}

export function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP_MS;
}

export function intField(o: Obj, key: string, min: number, max: number): number {
  const value = o[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new PayloadError(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** Length in Unicode code points, the unit of every "N chars" limit in the protocol. */
export function codePointLength(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    count++;
  }
  return count;
}

/**
 * JSON escapes can smuggle unpaired surrogates (`"\ud800"`) into strings; they cannot be encoded as
 * UTF-8 again (export, re-encryption), so such strings are rejected up front.
 */
export function isWellFormedText(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function textField(o: Obj, key: string, minChars: number, maxChars: number): string {
  const value = o[key];
  if (typeof value !== 'string' || !isWellFormedText(value)) throw new PayloadError(`${key} must be a string`);
  // Cheap pre-check before counting: a string longer than 2 code units per allowed char is too long.
  const length = value.length > maxChars * 2 ? Number.POSITIVE_INFINITY : codePointLength(value);
  if (length < minChars || length > maxChars) {
    throw new PayloadError(`${key} must have ${minChars} to ${maxChars} characters`);
  }
  return value;
}

/** Standard base64 that decodes to exactly `length` bytes (keys). */
export function base64KeyField(o: Obj, key: string, length: number): string {
  const value = o[key];
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(length / 3)) {
    throw new PayloadError(`${key} must be base64 of ${length} bytes`);
  }
  try {
    fromBase64Exact(value, length);
  } catch {
    throw new PayloadError(`${key} must be base64 of ${length} bytes`);
  }
  return value;
}

export function arrayField(o: Obj, key: string, maxItems: number): unknown[] {
  const value = o[key];
  if (!Array.isArray(value)) throw new PayloadError(`${key} must be an array`);
  if (value.length > maxItems) throw new PayloadError(`${key} has more than ${maxItems} items`);
  return value;
}
