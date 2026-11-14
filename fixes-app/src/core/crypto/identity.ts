import { ed25519 } from '@noble/curves/ed25519.js';

import { bytesEqual, fromBase64, toBase64, utf8Encode } from './encoding';
import { CryptoError } from './errors';
import { randomBytes } from './random';

/** Account identity key (AIK, protocol §4.1): Ed25519, one per account. */
export interface IdentityKeyPair {
  /** 32-byte Ed25519 seed. */
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export const ED25519_KEY_LENGTH = 32;
export const ED25519_SIGNATURE_LENGTH = 64;

export function generateIdentityKeyPair(): IdentityKeyPair {
  const secretKey = randomBytes(ED25519_KEY_LENGTH);
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

/** True when `secretKey` really is the secret half of `publicKey` (used before trusting a stored or transferred AIK). */
export function identityKeyPairMatches(secretKey: Uint8Array, publicKey: Uint8Array): boolean {
  if (secretKey.length !== ED25519_KEY_LENGTH || publicKey.length !== ED25519_KEY_LENGTH) return false;
  return bytesEqual(ed25519.getPublicKey(secretKey), publicKey);
}

export function signDetached(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  if (secretKey.length !== ED25519_KEY_LENGTH) {
    throw new CryptoError('invalid_key', 'Ed25519 secret key must be 32 bytes');
  }
  return ed25519.sign(message, secretKey);
}

/**
 * Strict RFC 8032 verification (zip215 off, matching the server's OpenSSL-based check). Malformed
 * inputs return false instead of throwing because they come from the network.
 */
export function verifyDetached(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== ED25519_SIGNATURE_LENGTH || publicKey.length !== ED25519_KEY_LENGTH) return false;
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    // noble throws on points that are not on the curve; for a verifier that simply means "invalid".
    return false;
  }
}

/**
 * The exact signed message of a device certificate (protocol §4.1). The public key is embedded as
 * canonical standard base64 of the raw 32 bytes, so both sides derive the same string.
 */
export function deviceCertificateMessage(userId: string, deviceId: string, devicePublicKey: Uint8Array): Uint8Array {
  return utf8Encode(`fixes/v1/device-cert|${userId}|${deviceId}|${toBase64(devicePublicKey)}`);
}

/** Returns the base64 certificate for `PUT /v1/users/me/identity`, `/devices/{id}/certificate` or reset-identity. */
export function signDeviceCertificate(
  identity: IdentityKeyPair,
  userId: string,
  deviceId: string,
  devicePublicKey: Uint8Array,
): string {
  return toBase64(signDetached(deviceCertificateMessage(userId, deviceId, devicePublicKey), identity.secretKey));
}

export function verifyDeviceCertificate(params: {
  identityPublicKey: Uint8Array;
  userId: string;
  deviceId: string;
  devicePublicKey: Uint8Array;
  /** Base64 certificate as served by the API (may be null/garbage: then it is simply not valid). */
  certificate: string | null | undefined;
}): boolean {
  const { certificate } = params;
  if (typeof certificate !== 'string' || certificate.length === 0) return false;
  let signature: Uint8Array;
  try {
    signature = fromBase64(certificate);
  } catch {
    // A certificate that is not even base64 is just an invalid certificate.
    return false;
  }
  return verifyDetached(
    signature,
    deviceCertificateMessage(params.userId, params.deviceId, params.devicePublicKey),
    params.identityPublicKey,
  );
}
