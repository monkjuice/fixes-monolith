import type { Envelope, OutgoingEnvelope } from '../api/types';
import type { DeviceKeyPair } from '../crypto/deviceKeys';
import { fromBase64, toBase64 } from '../crypto/encoding';
import { openEnvelope, sealEnvelope, type EnvelopeKeyCache } from '../crypto/envelope';
import type { EligibleDevice } from '../trust/deviceDirectory';

/** Seals payloads for recipient devices and opens received envelopes with this device's keys (§4.2). */
export class EnvelopeCodec {
  constructor(
    private readonly self: { userId: string; deviceId: string; keys: DeviceKeyPair },
    private readonly cache: EnvelopeKeyCache,
  ) {}

  /** One envelope per recipient device; the plaintext is padded and sealed for each separately. */
  seal(payload: unknown, recipients: readonly EligibleDevice[]): OutgoingEnvelope[] {
    return recipients.map((recipient) => {
      const sealed = sealEnvelope({
        payload,
        senderUserId: this.self.userId,
        senderDeviceId: this.self.deviceId,
        senderKeys: this.self.keys,
        recipientDeviceId: recipient.deviceId,
        recipientPublicKey: recipient.publicKey,
        cache: this.cache,
      });
      return {
        recipient_device_id: recipient.deviceId,
        nonce: toBase64(sealed.nonce),
        ciphertext: toBase64(sealed.ciphertext),
      };
    });
  }

  /**
   * Decrypts an envelope addressed to this device. `senderPublicKey` must already be verified against
   * the sender's pinned AIK. Any failure is a CryptoError (permanent).
   */
  open(envelope: Envelope, senderPublicKey: Uint8Array): unknown {
    return openEnvelope({
      nonce: fromBase64(envelope.nonce),
      ciphertext: fromBase64(envelope.ciphertext),
      senderUserId: envelope.sender_user_id,
      senderDeviceId: envelope.sender_device_id,
      senderPublicKey,
      recipientDeviceId: this.self.deviceId,
      recipientKeys: this.self.keys,
      cache: this.cache,
    });
  }
}
