import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

import { fromBase64, toBase64, utf8Decode, utf8Encode } from './encoding';
import { CryptoError } from './errors';
import { isUuidV4, randomBytes } from './random';

/**
 * The inner sealed box of `link` and `history` payloads (protocol §7.3), keyed by the 32-byte
 * transfer secret that only travels inside the QR code.
 */

export type TransferKind = 'link' | 'history';

export const TRANSFER_KEY_LENGTH = 32;
const NONCE_LENGTH = 24;
/** Each history chunk's inner JSON is at most 48 000 bytes (protocol §7.3). */
export const MAX_TRANSFER_INNER_BYTES = 48000;

export interface TransferPayload {
  v: 1;
  kind: TransferKind;
  transfer_id: string;
  attempt_id: string;
  seq: number;
  total: number;
  nonce: string;
  sealed: string;
}

export interface TransferHeader {
  kind: TransferKind;
  transferId: string;
  attemptId: string;
  seq: number;
  total: number;
}

export function generateTransferKey(): Uint8Array {
  return randomBytes(TRANSFER_KEY_LENGTH);
}

export function transferAad(h: TransferHeader): Uint8Array {
  return utf8Encode(`fixes/v1/${h.kind}|${h.transferId}|${h.attemptId}|${h.seq}|${h.total}`);
}

function assertHeader(h: TransferHeader): void {
  if (h.kind !== 'link' && h.kind !== 'history') {
    throw new CryptoError('invalid_transfer', 'Unknown transfer kind');
  }
  if (!isUuidV4(h.transferId) || !isUuidV4(h.attemptId)) {
    throw new CryptoError('invalid_transfer', 'Transfer and attempt ids must be UUIDv4');
  }
  if (!Number.isSafeInteger(h.total) || h.total < 1 || !Number.isSafeInteger(h.seq) || h.seq < 0 || h.seq >= h.total) {
    throw new CryptoError('invalid_transfer', 'Invalid transfer sequence numbers');
  }
}

function assertKey(transferKey: Uint8Array): void {
  if (!(transferKey instanceof Uint8Array) || transferKey.length !== TRANSFER_KEY_LENGTH) {
    throw new CryptoError('invalid_key', 'Transfer key must be 32 bytes');
  }
}

export function sealTransfer(header: TransferHeader, inner: unknown, transferKey: Uint8Array): TransferPayload {
  assertHeader(header);
  assertKey(transferKey);
  const json = JSON.stringify(inner);
  if (typeof json !== 'string') throw new CryptoError('invalid_payload', 'Inner payload is not JSON-serialisable');
  const plaintext = utf8Encode(json);
  if (plaintext.length > MAX_TRANSFER_INNER_BYTES) {
    throw new CryptoError('payload_too_large', 'Transfer chunk exceeds 48 000 bytes');
  }
  const nonce = randomBytes(NONCE_LENGTH);
  const sealed = xchacha20poly1305(transferKey, nonce, transferAad(header)).encrypt(plaintext);
  return {
    v: 1,
    kind: header.kind,
    transfer_id: header.transferId,
    attempt_id: header.attemptId,
    seq: header.seq,
    total: header.total,
    nonce: toBase64(nonce),
    sealed: toBase64(sealed),
  };
}

/** Validates the outer fields of a decrypted `link`/`history` payload without opening it. */
export function parseTransferPayload(value: unknown): TransferPayload {
  if (typeof value !== 'object' || value === null) throw new CryptoError('invalid_transfer', 'Not an object');
  const p = value as Record<string, unknown>;
  if (p.v !== 1) throw new CryptoError('invalid_transfer', 'Unsupported version');
  const header: TransferHeader = {
    kind: p.kind as TransferKind,
    transferId: p.transfer_id as string,
    attemptId: p.attempt_id as string,
    seq: p.seq as number,
    total: p.total as number,
  };
  assertHeader(header);
  if (typeof p.nonce !== 'string' || typeof p.sealed !== 'string') {
    throw new CryptoError('invalid_transfer', 'Missing nonce or sealed box');
  }
  return {
    v: 1,
    kind: header.kind,
    transfer_id: header.transferId,
    attempt_id: header.attemptId,
    seq: header.seq,
    total: header.total,
    nonce: p.nonce,
    sealed: p.sealed,
  };
}

/** Opens the sealed box; any tampering with the header fields or the box fails authentication. */
export function openTransfer(value: unknown, transferKey: Uint8Array): { payload: TransferPayload; inner: unknown } {
  assertKey(transferKey);
  const payload = parseTransferPayload(value);
  const nonce = fromBase64(payload.nonce);
  if (nonce.length !== NONCE_LENGTH) throw new CryptoError('invalid_transfer', 'Nonce must be 24 bytes');
  const sealed = fromBase64(payload.sealed);
  const header: TransferHeader = {
    kind: payload.kind,
    transferId: payload.transfer_id,
    attemptId: payload.attempt_id,
    seq: payload.seq,
    total: payload.total,
  };
  let plaintext: Uint8Array;
  try {
    plaintext = xchacha20poly1305(transferKey, nonce, transferAad(header)).decrypt(sealed);
  } catch (cause) {
    throw new CryptoError('decrypt_failed', 'Transfer box authentication failed', { cause });
  }
  try {
    return { payload, inner: JSON.parse(utf8Decode(plaintext)) };
  } catch (cause) {
    throw new CryptoError('invalid_payload', 'Transfer box is not valid UTF-8 JSON', { cause });
  }
}
