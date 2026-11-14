import { x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { assertX25519Key, type DeviceKeyPair } from './deviceKeys';
import { concatBytes, isAllZero, toBase64, utf8Decode, utf8Encode } from './encoding';
import { CryptoError } from './errors';
import { randomBytes } from './random';

/** Envelope encryption, protocol §4.2. */

export const ENVELOPE_NONCE_LENGTH = 24;
export const PADDING_BLOCK = 256;
const TAG_LENGTH = 16;
/** Server limit on decoded ciphertext (protocol §5.3). */
export const MAX_ENVELOPE_CIPHERTEXT = 65536;
/** Largest padded plaintext that still fits the ciphertext limit (255 blocks). */
export const MAX_PADDED_PLAINTEXT =
  Math.floor((MAX_ENVELOPE_CIPHERTEXT - TAG_LENGTH) / PADDING_BLOCK) * PADDING_BLOCK;

const INFO_PREFIX = utf8Encode('fixes/v1/envelope');

/** Right-pads with ASCII spaces to a multiple of 256 bytes (an already aligned input is left as is). */
export function padPlaintext(bytes: Uint8Array): Uint8Array {
  const padded = Math.max(PADDING_BLOCK, Math.ceil(bytes.length / PADDING_BLOCK) * PADDING_BLOCK);
  if (padded === bytes.length) return bytes;
  const out = new Uint8Array(padded).fill(0x20);
  out.set(bytes, 0);
  return out;
}

export function envelopeAad(senderUserId: string, senderDeviceId: string, recipientDeviceId: string): Uint8Array {
  return utf8Encode(`fixes/v1|${senderUserId}|${senderDeviceId}|${recipientDeviceId}`);
}

/**
 * key = HKDF-SHA256(ikm = X25519(local_sk, peer_pk), salt = empty,
 *                   info = "fixes/v1/envelope" || sender_pk || recipient_pk, L = 32)
 * The sender public key always comes first, so the two directions of a device pair use different keys.
 */
export function deriveEnvelopeKey(
  localSecretKey: Uint8Array,
  peerPublicKey: Uint8Array,
  senderPublicKey: Uint8Array,
  recipientPublicKey: Uint8Array,
): Uint8Array {
  assertX25519Key(localSecretKey, 'Local secret key');
  assertX25519Key(peerPublicKey, 'Peer public key');
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(localSecretKey, peerPublicKey);
  } catch (cause) {
    // noble refuses low-order points instead of returning the all-zero secret; same outcome.
    throw new CryptoError('invalid_shared_secret', 'X25519 produced an all-zero shared secret', { cause });
  }
  if (isAllZero(shared)) {
    throw new CryptoError('invalid_shared_secret', 'X25519 produced an all-zero shared secret');
  }
  return hkdf(sha256, shared, new Uint8Array(0), concatBytes(INFO_PREFIX, senderPublicKey, recipientPublicKey), 32);
}

/**
 * In-memory cache of derived keys. The spec keys it by (local device id, peer device id, peer public
 * key); the direction is added because the HKDF info order makes send and receive keys differ.
 * Bounded so a hostile server cannot grow it without limit.
 */
export class EnvelopeKeyCache {
  private readonly entries = new Map<string, Uint8Array>();

  constructor(private readonly maxEntries = 1024) {}

  get(
    direction: 'send' | 'receive',
    localDeviceId: string,
    peerDeviceId: string,
    peerPublicKey: Uint8Array,
    derive: () => Uint8Array,
  ): Uint8Array {
    const cacheKey = `${direction}|${localDeviceId}|${peerDeviceId}|${toBase64(peerPublicKey)}`;
    const hit = this.entries.get(cacheKey);
    if (hit) {
      // Re-insert to keep recently used keys at the end (Map preserves insertion order).
      this.entries.delete(cacheKey);
      this.entries.set(cacheKey, hit);
      return hit;
    }
    const key = derive();
    this.entries.set(cacheKey, key);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return key;
  }

  clear(): void {
    for (const key of this.entries.values()) key.fill(0);
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface SealEnvelopeParams {
  /** JSON-serialisable payload (protocol §7). */
  payload: unknown;
  senderUserId: string;
  senderDeviceId: string;
  senderKeys: DeviceKeyPair;
  recipientDeviceId: string;
  recipientPublicKey: Uint8Array;
  cache?: EnvelopeKeyCache;
}

export interface SealedEnvelope {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

export function sealEnvelope(params: SealEnvelopeParams): SealedEnvelope {
  const { senderKeys, recipientPublicKey } = params;
  assertX25519Key(senderKeys.publicKey, 'Sender public key');
  assertX25519Key(recipientPublicKey, 'Recipient public key');
  const json = JSON.stringify(params.payload);
  if (typeof json !== 'string') {
    throw new CryptoError('invalid_payload', 'Payload is not JSON-serialisable');
  }
  const plaintext = padPlaintext(utf8Encode(json));
  if (plaintext.length > MAX_PADDED_PLAINTEXT) {
    throw new CryptoError('payload_too_large', 'Payload exceeds the envelope size limit');
  }
  const derive = () =>
    deriveEnvelopeKey(senderKeys.secretKey, recipientPublicKey, senderKeys.publicKey, recipientPublicKey);
  const key = params.cache
    ? params.cache.get('send', params.senderDeviceId, params.recipientDeviceId, recipientPublicKey, derive)
    : derive();
  const nonce = randomBytes(ENVELOPE_NONCE_LENGTH);
  const aad = envelopeAad(params.senderUserId, params.senderDeviceId, params.recipientDeviceId);
  const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
  return { nonce, ciphertext };
}

export interface OpenEnvelopeParams {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  /** Taken from the server's envelope metadata (never from the payload). */
  senderUserId: string;
  senderDeviceId: string;
  /** Must be a key that the caller already verified against the sender's pinned AIK (§4.2, §8). */
  senderPublicKey: Uint8Array;
  recipientDeviceId: string;
  recipientKeys: DeviceKeyPair;
  cache?: EnvelopeKeyCache;
}

/** Decrypts and parses one envelope. Any failure is a permanent CryptoError (protocol §13). */
export function openEnvelope(params: OpenEnvelopeParams): unknown {
  const { recipientKeys, senderPublicKey } = params;
  if (params.nonce.length !== ENVELOPE_NONCE_LENGTH) {
    throw new CryptoError('decrypt_failed', 'Envelope nonce must be 24 bytes');
  }
  if (params.ciphertext.length < TAG_LENGTH || params.ciphertext.length > MAX_ENVELOPE_CIPHERTEXT) {
    throw new CryptoError('decrypt_failed', 'Envelope ciphertext has an invalid length');
  }
  assertX25519Key(senderPublicKey, 'Sender public key');
  assertX25519Key(recipientKeys.publicKey, 'Recipient public key');
  const derive = () =>
    deriveEnvelopeKey(recipientKeys.secretKey, senderPublicKey, senderPublicKey, recipientKeys.publicKey);
  const key = params.cache
    ? params.cache.get('receive', params.recipientDeviceId, params.senderDeviceId, senderPublicKey, derive)
    : derive();
  const aad = envelopeAad(params.senderUserId, params.senderDeviceId, params.recipientDeviceId);
  let plaintext: Uint8Array;
  try {
    plaintext = xchacha20poly1305(key, params.nonce, aad).decrypt(params.ciphertext);
  } catch (cause) {
    throw new CryptoError('decrypt_failed', 'Envelope authentication failed', { cause });
  }
  try {
    // Trailing padding spaces are valid JSON whitespace.
    return JSON.parse(utf8Decode(plaintext));
  } catch (cause) {
    throw new CryptoError('invalid_payload', 'Envelope plaintext is not valid UTF-8 JSON', { cause });
  }
}
