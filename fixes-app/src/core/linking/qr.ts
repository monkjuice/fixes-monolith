import { fromBase64Url, toBase64Url } from '../crypto/encoding';
import { CryptoError } from '../crypto/errors';
import { isUuidV4 } from '../crypto/random';

/**
 * The link QR code of protocol §9 step 2:
 * `fixes-link:1:<transfer_id>:<B device id>:<B X25519 public key b64url>:<transfer_key b64url (32 bytes)>`.
 * The transfer key only ever travels inside this code.
 */

export interface LinkQr {
  transferId: string;
  deviceId: string;
  devicePublicKey: Uint8Array;
  transferKey: Uint8Array;
}

export class LinkQrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinkQrError';
  }
}

const PREFIX = 'fixes-link';
const VERSION = '1';
// Generous upper bound: the real code is about 150 characters.
const MAX_LENGTH = 512;

export function formatLinkQr(qr: LinkQr): string {
  if (!isUuidV4(qr.transferId) || !isUuidV4(qr.deviceId)) throw new LinkQrError('Invalid link ids');
  if (qr.devicePublicKey.length !== 32 || qr.transferKey.length !== 32) throw new LinkQrError('Invalid link keys');
  return [PREFIX, VERSION, qr.transferId, qr.deviceId, toBase64Url(qr.devicePublicKey), toBase64Url(qr.transferKey)].join(
    ':',
  );
}

function decodeKey(text: string, what: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(text);
  } catch (error) {
    if (error instanceof CryptoError) throw new LinkQrError(`Invalid ${what}`);
    throw error;
  }
  // Exactly 32 bytes in canonical spelling, so one key has one accepted encoding.
  if (bytes.length !== 32 || toBase64Url(bytes) !== text) throw new LinkQrError(`Invalid ${what}`);
  return bytes;
}

/** Parses a scanned code strictly; anything else (another app's QR, a damaged scan) is refused. */
export function parseLinkQr(text: string): LinkQr {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed.length === 0 || trimmed.length > MAX_LENGTH) throw new LinkQrError('Not a Fixes link code');
  const parts = trimmed.split(':');
  if (parts.length !== 6 || parts[0] !== PREFIX) throw new LinkQrError('Not a Fixes link code');
  if (parts[1] !== VERSION) throw new LinkQrError('This link code needs a newer version of Fixes');
  const [, , transferId, deviceId, publicKey, transferKey] = parts;
  if (!isUuidV4(transferId) || !isUuidV4(deviceId)) throw new LinkQrError('Invalid link code');
  return {
    transferId,
    deviceId,
    devicePublicKey: decodeKey(publicKey, 'device key'),
    transferKey: decodeKey(transferKey, 'transfer key'),
  };
}
