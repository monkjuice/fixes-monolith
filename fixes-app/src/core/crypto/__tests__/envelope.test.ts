import { x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { generateDeviceKeyPair, type DeviceKeyPair } from '../deviceKeys';
import { concatBytes, utf8Decode, utf8Encode } from '../encoding';
import {
  deriveEnvelopeKey,
  EnvelopeKeyCache,
  MAX_PADDED_PLAINTEXT,
  openEnvelope,
  padPlaintext,
  sealEnvelope,
} from '../envelope';
import { CryptoError } from '../errors';
import { uuidv4 } from '../random';

interface Party {
  userId: string;
  deviceId: string;
  keys: DeviceKeyPair;
}

function party(): Party {
  return { userId: uuidv4(), deviceId: uuidv4(), keys: generateDeviceKeyPair() };
}

const payload = { v: 1, kind: 'message', id: uuidv4(), body: 'hola 👋', sent_at: 1731492000000 };

function seal(from: Party, to: Party, p: unknown = payload) {
  return sealEnvelope({
    payload: p,
    senderUserId: from.userId,
    senderDeviceId: from.deviceId,
    senderKeys: from.keys,
    recipientDeviceId: to.deviceId,
    recipientPublicKey: to.keys.publicKey,
  });
}

function open(sealed: { nonce: Uint8Array; ciphertext: Uint8Array }, from: Party, to: Party) {
  return openEnvelope({
    ...sealed,
    senderUserId: from.userId,
    senderDeviceId: from.deviceId,
    senderPublicKey: from.keys.publicKey,
    recipientDeviceId: to.deviceId,
    recipientKeys: to.keys,
  });
}

function expectCryptoError(fn: () => unknown, code: string) {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CryptoError);
  expect((caught as CryptoError).code).toBe(code);
}

describe('envelope encryption (§4.2)', () => {
  const alice = party();
  const bob = party();

  it('round-trips between two key pairs', () => {
    const sealed = seal(alice, bob);
    expect(sealed.nonce).toHaveLength(24);
    expect(open(sealed, alice, bob)).toEqual(payload);
  });

  it('follows the spec exactly: X25519, HKDF info = label || sender_pk || recipient_pk, AAD, space padding', () => {
    const sealed = seal(alice, bob);
    const shared = x25519.getSharedSecret(bob.keys.secretKey, alice.keys.publicKey);
    const key = hkdf(
      sha256,
      shared,
      new Uint8Array(0),
      concatBytes(utf8Encode('fixes/v1/envelope'), alice.keys.publicKey, bob.keys.publicKey),
      32,
    );
    const aad = utf8Encode(`fixes/v1|${alice.userId}|${alice.deviceId}|${bob.deviceId}`);
    const plaintext = xchacha20poly1305(key, sealed.nonce, aad).decrypt(sealed.ciphertext);
    expect(plaintext.length % 256).toBe(0);
    const json = JSON.stringify(payload);
    const text = utf8Decode(plaintext);
    expect(text.startsWith(json)).toBe(true);
    expect(text.slice(json.length)).toMatch(/^ *$/);
  });

  it('uses a fresh nonce per envelope', () => {
    const a = seal(alice, bob);
    const b = seal(alice, bob);
    expect(a.nonce).not.toEqual(b.nonce);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it('fails with the wrong recipient key', () => {
    const sealed = seal(alice, bob);
    const mallory = party();
    expectCryptoError(() => open(sealed, alice, { ...bob, keys: mallory.keys }), 'decrypt_failed');
  });

  it('fails with the wrong sender public key', () => {
    const sealed = seal(alice, bob);
    expectCryptoError(() => open(sealed, { ...alice, keys: party().keys }, bob), 'decrypt_failed');
  });

  it('fails when the ciphertext or nonce is tampered with', () => {
    const sealed = seal(alice, bob);
    const ciphertext = sealed.ciphertext.slice();
    ciphertext[10] ^= 1;
    expectCryptoError(() => open({ ...sealed, ciphertext }, alice, bob), 'decrypt_failed');
    const nonce = sealed.nonce.slice();
    nonce[0] ^= 1;
    expectCryptoError(() => open({ ...sealed, nonce }, alice, bob), 'decrypt_failed');
  });

  it('fails when the AAD differs (envelope re-addressed to another recipient device id)', () => {
    const sealed = seal(alice, bob);
    expectCryptoError(() => open(sealed, alice, { ...bob, deviceId: uuidv4() }), 'decrypt_failed');
  });

  it('fails when the claimed sender user or device differs', () => {
    const sealed = seal(alice, bob);
    expectCryptoError(() => open(sealed, { ...alice, userId: uuidv4() }, bob), 'decrypt_failed');
    expectCryptoError(() => open(sealed, { ...alice, deviceId: uuidv4() }, bob), 'decrypt_failed');
  });

  it('rejects a reflected envelope (sent A→B, replayed to A as if from B)', () => {
    const sealed = seal(alice, bob);
    // Same device pair, opposite direction: the HKDF info order and AAD both differ.
    expectCryptoError(() => open(sealed, bob, alice), 'decrypt_failed');
    expect(deriveEnvelopeKey(alice.keys.secretKey, bob.keys.publicKey, alice.keys.publicKey, bob.keys.publicKey)).not.toEqual(
      deriveEnvelopeKey(alice.keys.secretKey, bob.keys.publicKey, bob.keys.publicKey, alice.keys.publicKey),
    );
  });

  it('pads to multiples of 256 bytes with spaces', () => {
    expect(padPlaintext(new Uint8Array(1))).toHaveLength(256);
    expect(padPlaintext(new Uint8Array(255))).toHaveLength(256);
    expect(padPlaintext(new Uint8Array(256))).toHaveLength(256);
    expect(padPlaintext(new Uint8Array(257))).toHaveLength(512);
    const padded = padPlaintext(utf8Encode('{}'));
    expect(utf8Decode(padded)).toBe(`{}${' '.repeat(254)}`);
    // Ciphertext sizes reveal only the bucket.
    expect(seal(alice, bob, { body: 'a' }).ciphertext).toHaveLength(256 + 16);
    expect(seal(alice, bob, { body: 'a'.repeat(300) }).ciphertext).toHaveLength(512 + 16);
  });

  it('refuses payloads that would exceed the server ciphertext limit', () => {
    expect(MAX_PADDED_PLAINTEXT).toBe(65280);
    expect(() => seal(alice, bob, { body: 'x'.repeat(65280 - 11) })).not.toThrow();
    expectCryptoError(() => seal(alice, bob, { body: 'x'.repeat(65280) }), 'payload_too_large');
  });

  it('rejects an all-zero shared secret (low-order peer key)', () => {
    const lowOrder = new Uint8Array(32); // u = 0
    expectCryptoError(
      () =>
        sealEnvelope({
          payload,
          senderUserId: alice.userId,
          senderDeviceId: alice.deviceId,
          senderKeys: alice.keys,
          recipientDeviceId: bob.deviceId,
          recipientPublicKey: lowOrder,
        }),
      'invalid_shared_secret',
    );
    const one = new Uint8Array(32);
    one[0] = 1; // u = 1, another low-order point
    expectCryptoError(
      () => deriveEnvelopeKey(alice.keys.secretKey, one, one, alice.keys.publicKey),
      'invalid_shared_secret',
    );
  });

  it('rejects malformed plaintext JSON after successful decryption', () => {
    const shared = x25519.getSharedSecret(alice.keys.secretKey, bob.keys.publicKey);
    const key = hkdf(sha256, shared, new Uint8Array(0), concatBytes(utf8Encode('fixes/v1/envelope'), alice.keys.publicKey, bob.keys.publicKey), 32);
    const nonce = new Uint8Array(24).fill(7);
    const aad = utf8Encode(`fixes/v1|${alice.userId}|${alice.deviceId}|${bob.deviceId}`);
    const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(padPlaintext(utf8Encode('{not json')));
    expectCryptoError(() => open({ nonce, ciphertext }, alice, bob), 'invalid_payload');
  });

  it('caches derived keys per direction and device pair', () => {
    const cache = new EnvelopeKeyCache(2);
    const sealed = sealEnvelope({
      payload,
      senderUserId: alice.userId,
      senderDeviceId: alice.deviceId,
      senderKeys: alice.keys,
      recipientDeviceId: bob.deviceId,
      recipientPublicKey: bob.keys.publicKey,
      cache,
    });
    expect(cache.size).toBe(1);
    const bobCache = new EnvelopeKeyCache();
    const opened = openEnvelope({
      ...sealed,
      senderUserId: alice.userId,
      senderDeviceId: alice.deviceId,
      senderPublicKey: alice.keys.publicKey,
      recipientDeviceId: bob.deviceId,
      recipientKeys: bob.keys,
      cache: bobCache,
    });
    expect(opened).toEqual(payload);
    let derivations = 0;
    const derive = () => {
      derivations++;
      return new Uint8Array(32);
    };
    const peer = party();
    bobCache.get('receive', bob.deviceId, peer.deviceId, peer.keys.publicKey, derive);
    bobCache.get('receive', bob.deviceId, peer.deviceId, peer.keys.publicKey, derive);
    expect(derivations).toBe(1);
    // A different peer key (device re-keyed) or direction is a different entry.
    bobCache.get('send', bob.deviceId, peer.deviceId, peer.keys.publicKey, derive);
    bobCache.get('receive', bob.deviceId, peer.deviceId, party().keys.publicKey, derive);
    expect(derivations).toBe(3);
    // Bounded: the size never exceeds the limit.
    expect(cache.size).toBeLessThanOrEqual(2);
    bobCache.clear();
    expect(bobCache.size).toBe(0);
  });
});
