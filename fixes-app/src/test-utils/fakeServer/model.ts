/** State records of the in-memory FakeFixesServer (mirrors protocol §11, without MongoDB). */

export interface FakeUser {
  id: string;
  username: string;
  password: string;
  /** Base64 AIK public key (`users.identity_key`), mutable by tests. */
  identityKey: string | null;
  avatarUrl: string | null;
}

export class FakeDevice {
  certificate: string | null = null;
  revokedAt: string | null = null;
  /** Set when a mailbox cap dropped envelopes; reported once as `gap: true`. */
  overflowAt: string | null = null;
  lastSeenAt: string;

  constructor(
    readonly id: string,
    readonly userId: string,
    readonly name: string,
    readonly publicKey: string,
    readonly createdAt: string,
  ) {
    this.lastSeenAt = createdAt;
  }

  get revoked(): boolean {
    return this.revokedAt !== null;
  }
}

export interface FakeEnvelope {
  id: string;
  recipientDeviceId: string;
  recipientUserId: string;
  senderUserId: string;
  senderDeviceId: string;
  nonce: string;
  ciphertext: string;
  createdAt: string;
}

export interface FakeFriendRequest {
  id: string;
  fromUserId: string;
  toUserId: string;
  createdAt: string;
}

/** One accepted `POST /v1/envelopes` (lets tests count envelopes per sender without decrypting). */
export interface EnvelopePost {
  senderUserId: string;
  senderDeviceId: string;
  recipientDeviceIds: string[];
  completeFor: string[];
  createdAt: string;
}

export function pairKey(a: string, b: string): string {
  return [a, b].sort().join(':');
}

export function wireEnvelope(envelope: FakeEnvelope) {
  return {
    id: envelope.id,
    sender_user_id: envelope.senderUserId,
    sender_device_id: envelope.senderDeviceId,
    recipient_device_id: envelope.recipientDeviceId,
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
    created_at: envelope.createdAt,
  };
}
