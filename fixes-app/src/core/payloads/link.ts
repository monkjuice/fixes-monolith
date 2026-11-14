import { fromBase64Exact, toBase64 } from '../crypto/encoding';
import { ED25519_KEY_LENGTH, identityKeyPairMatches, type IdentityKeyPair } from '../crypto/identity';
import { asObject, base64KeyField, PayloadError } from './fields';

/** Inner content of the `link` sealed box (protocol §7.3): the account identity key pair. */
export interface LinkInner {
  identity_public_key: string;
  identity_secret_key: string;
}

export function buildLinkInner(identity: IdentityKeyPair): LinkInner {
  return { identity_public_key: toBase64(identity.publicKey), identity_secret_key: toBase64(identity.secretKey) };
}

/** Parses the inner object and checks that the secret really is the secret half of the public key. */
export function parseLinkInner(value: unknown): IdentityKeyPair {
  const o = asObject(value, 'link');
  const publicKey = fromBase64Exact(base64KeyField(o, 'identity_public_key', ED25519_KEY_LENGTH), ED25519_KEY_LENGTH);
  const secretKey = fromBase64Exact(base64KeyField(o, 'identity_secret_key', ED25519_KEY_LENGTH), ED25519_KEY_LENGTH);
  if (!identityKeyPairMatches(secretKey, publicKey)) {
    throw new PayloadError('The identity secret does not match its public key');
  }
  return { publicKey, secretKey };
}
