import { ed25519 } from '@noble/curves/ed25519.js';

import { generateDeviceKeyPair } from '../deviceKeys';
import { fromBase64, toBase64, utf8Decode } from '../encoding';
import {
  deviceCertificateMessage,
  generateIdentityKeyPair,
  identityKeyPairMatches,
  signDeviceCertificate,
  verifyDeviceCertificate,
} from '../identity';
import { uuidv4 } from '../random';

describe('identity keys and device certificates', () => {
  const userId = uuidv4();
  const deviceId = uuidv4();

  it('builds the exact §4.1 certificate message', () => {
    const pub = Uint8Array.from({ length: 32 }, (_, i) => i);
    const message = utf8Decode(deviceCertificateMessage(userId, deviceId, pub));
    expect(message).toBe(`fixes/v1/device-cert|${userId}|${deviceId}|${toBase64(pub)}`);
  });

  it('signs a 64-byte certificate that verifies under the AIK', () => {
    const aik = generateIdentityKeyPair();
    const device = generateDeviceKeyPair();
    const cert = signDeviceCertificate(aik, userId, deviceId, device.publicKey);
    expect(fromBase64(cert)).toHaveLength(64);
    // Independent check with noble directly, against the documented message.
    expect(ed25519.verify(fromBase64(cert), deviceCertificateMessage(userId, deviceId, device.publicKey), aik.publicKey)).toBe(true);
    expect(
      verifyDeviceCertificate({ identityPublicKey: aik.publicKey, userId, deviceId, devicePublicKey: device.publicKey, certificate: cert }),
    ).toBe(true);
  });

  it('rejects a certificate for another user, device, key or AIK', () => {
    const aik = generateIdentityKeyPair();
    const device = generateDeviceKeyPair();
    const cert = signDeviceCertificate(aik, userId, deviceId, device.publicKey);
    const base = { identityPublicKey: aik.publicKey, userId, deviceId, devicePublicKey: device.publicKey, certificate: cert };
    expect(verifyDeviceCertificate({ ...base, userId: uuidv4() })).toBe(false);
    expect(verifyDeviceCertificate({ ...base, deviceId: uuidv4() })).toBe(false);
    expect(verifyDeviceCertificate({ ...base, devicePublicKey: generateDeviceKeyPair().publicKey })).toBe(false);
    expect(verifyDeviceCertificate({ ...base, identityPublicKey: generateIdentityKeyPair().publicKey })).toBe(false);
  });

  it('treats missing or malformed certificates as invalid instead of throwing', () => {
    const aik = generateIdentityKeyPair();
    const base = { identityPublicKey: aik.publicKey, userId, deviceId, devicePublicKey: generateDeviceKeyPair().publicKey };
    expect(verifyDeviceCertificate({ ...base, certificate: null })).toBe(false);
    expect(verifyDeviceCertificate({ ...base, certificate: '' })).toBe(false);
    expect(verifyDeviceCertificate({ ...base, certificate: 'not base64!' })).toBe(false);
    expect(verifyDeviceCertificate({ ...base, certificate: toBase64(new Uint8Array(10)) })).toBe(false);
    expect(verifyDeviceCertificate({ ...base, certificate: toBase64(new Uint8Array(64)) })).toBe(false);
  });

  it('checks that a secret key belongs to a public key', () => {
    const a = generateIdentityKeyPair();
    const b = generateIdentityKeyPair();
    expect(identityKeyPairMatches(a.secretKey, a.publicKey)).toBe(true);
    expect(identityKeyPairMatches(a.secretKey, b.publicKey)).toBe(false);
    expect(identityKeyPairMatches(new Uint8Array(31), a.publicKey)).toBe(false);
  });
});
