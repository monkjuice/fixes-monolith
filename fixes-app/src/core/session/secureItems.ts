import type { RefreshTokenStore } from '../api/tokens';
import { deviceKeyPairMatches, type DeviceKeyPair } from '../crypto/deviceKeys';
import { fromBase64Exact, toBase64 } from '../crypto/encoding';
import { identityKeyPairMatches, type IdentityKeyPair } from '../crypto/identity';
import { isUuidV4 } from '../crypto/random';
import { isDatabaseKeyHex } from '../db/sqlcipher';
import type { SecureKeyValueStore } from '../platform';

/**
 * The secure-storage items of protocol §12.1. Platform implementations must store every item with
 * keychainAccessible WHEN_UNLOCKED_THIS_DEVICE_ONLY. Key material is stored as standard base64.
 */
export const SecureKeys = {
  session: 'fixes.session',
  device: (userId: string) => `fixes.device.${userId}`,
  identity: (userId: string) => `fixes.identity.${userId}`,
  dbKey: (userId: string) => `fixes.dbkey.${userId}`,
  backupKey: (userId: string) => `fixes.backupkey.${userId}`,
} as const;

/** `fixes.session` */
export interface StoredSession {
  user_id: string;
  device_id: string;
  refresh_token: string;
}

/** `fixes.device.<user_id>` (keys as base64). */
export interface StoredDeviceKey {
  device_id: string;
  public_key: string;
  secret_key: string;
}

/** `fixes.identity.<user_id>` (keys as base64). */
export interface StoredIdentity {
  public_key: string;
  secret_key: string;
}

export class CorruptSecureItemError extends Error {
  constructor(readonly key: string) {
    // The key name is safe to show; the value never is.
    super(`Secure storage item ${key} is corrupt`);
    this.name = 'CorruptSecureItemError';
  }
}

function assertUserId(userId: string): void {
  // User ids become part of storage keys and file names; never accept anything but a UUIDv4.
  if (!isUuidV4(userId)) throw new RangeError('Invalid user id');
}

/** Typed, validated access to the §12.1 items. */
export class SecureItems {
  constructor(private readonly store: SecureKeyValueStore) {}

  private async readJson(key: string): Promise<Record<string, unknown> | null> {
    const raw = await this.store.getItem(key);
    if (raw === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new CorruptSecureItemError(key);
    }
    if (typeof value !== 'object' || value === null) throw new CorruptSecureItemError(key);
    return value as Record<string, unknown>;
  }

  // ---- fixes.session ----

  async getSession(): Promise<StoredSession | null> {
    const v = await this.readJson(SecureKeys.session);
    if (v === null) return null;
    if (!isUuidV4(v.user_id) || !isUuidV4(v.device_id) || typeof v.refresh_token !== 'string' || v.refresh_token === '') {
      throw new CorruptSecureItemError(SecureKeys.session);
    }
    return { user_id: v.user_id, device_id: v.device_id, refresh_token: v.refresh_token };
  }

  setSession(session: StoredSession): Promise<void> {
    assertUserId(session.user_id);
    return this.store.setItem(SecureKeys.session, JSON.stringify(session));
  }

  deleteSession(): Promise<void> {
    return this.store.deleteItem(SecureKeys.session);
  }

  // ---- fixes.device.<user_id> ----

  async getDeviceKey(userId: string): Promise<{ deviceId: string; keys: DeviceKeyPair } | null> {
    assertUserId(userId);
    const key = SecureKeys.device(userId);
    const v = await this.readJson(key);
    if (v === null) return null;
    try {
      if (!isUuidV4(v.device_id) || typeof v.public_key !== 'string' || typeof v.secret_key !== 'string') throw new Error();
      const keys = { publicKey: fromBase64Exact(v.public_key, 32), secretKey: fromBase64Exact(v.secret_key, 32) };
      if (!deviceKeyPairMatches(keys.secretKey, keys.publicKey)) throw new Error();
      return { deviceId: v.device_id, keys };
    } catch {
      throw new CorruptSecureItemError(key);
    }
  }

  setDeviceKey(userId: string, deviceId: string, keys: DeviceKeyPair): Promise<void> {
    assertUserId(userId);
    const item: StoredDeviceKey = {
      device_id: deviceId,
      public_key: toBase64(keys.publicKey),
      secret_key: toBase64(keys.secretKey),
    };
    return this.store.setItem(SecureKeys.device(userId), JSON.stringify(item));
  }

  deleteDeviceKey(userId: string): Promise<void> {
    assertUserId(userId);
    return this.store.deleteItem(SecureKeys.device(userId));
  }

  // ---- fixes.identity.<user_id> ----

  async getIdentity(userId: string): Promise<IdentityKeyPair | null> {
    assertUserId(userId);
    const key = SecureKeys.identity(userId);
    const v = await this.readJson(key);
    if (v === null) return null;
    try {
      if (typeof v.public_key !== 'string' || typeof v.secret_key !== 'string') throw new Error();
      const pair = { publicKey: fromBase64Exact(v.public_key, 32), secretKey: fromBase64Exact(v.secret_key, 32) };
      if (!identityKeyPairMatches(pair.secretKey, pair.publicKey)) throw new Error();
      return pair;
    } catch {
      throw new CorruptSecureItemError(key);
    }
  }

  /** Raw item, used to restore a previous identity when a reset is rejected. */
  getIdentityRaw(userId: string): Promise<string | null> {
    assertUserId(userId);
    return this.store.getItem(SecureKeys.identity(userId));
  }

  setIdentityRaw(userId: string, raw: string): Promise<void> {
    assertUserId(userId);
    return this.store.setItem(SecureKeys.identity(userId), raw);
  }

  setIdentity(userId: string, identity: IdentityKeyPair): Promise<void> {
    assertUserId(userId);
    const item: StoredIdentity = { public_key: toBase64(identity.publicKey), secret_key: toBase64(identity.secretKey) };
    return this.store.setItem(SecureKeys.identity(userId), JSON.stringify(item));
  }

  deleteIdentity(userId: string): Promise<void> {
    assertUserId(userId);
    return this.store.deleteItem(SecureKeys.identity(userId));
  }

  // ---- fixes.dbkey.<user_id> ----

  async getDbKey(userId: string): Promise<string | null> {
    assertUserId(userId);
    const key = SecureKeys.dbKey(userId);
    const raw = await this.store.getItem(key);
    if (raw === null) return null;
    if (!isDatabaseKeyHex(raw)) throw new CorruptSecureItemError(key);
    return raw;
  }

  setDbKey(userId: string, keyHex: string): Promise<void> {
    assertUserId(userId);
    if (!isDatabaseKeyHex(keyHex)) throw new RangeError('Database key must be 64 lowercase hex characters');
    return this.store.setItem(SecureKeys.dbKey(userId), keyHex);
  }

  deleteDbKey(userId: string): Promise<void> {
    assertUserId(userId);
    return this.store.deleteItem(SecureKeys.dbKey(userId));
  }

  // ---- fixes.backupkey.<user_id> (formatted recovery key, §4.3; used by part 2 backups) ----

  getBackupKey(userId: string): Promise<string | null> {
    assertUserId(userId);
    return this.store.getItem(SecureKeys.backupKey(userId));
  }

  setBackupKey(userId: string, formattedRecoveryKey: string): Promise<void> {
    assertUserId(userId);
    return this.store.setItem(SecureKeys.backupKey(userId), formattedRecoveryKey);
  }

  deleteBackupKey(userId: string): Promise<void> {
    assertUserId(userId);
    return this.store.deleteItem(SecureKeys.backupKey(userId));
  }

  /** Erase this device (§12.1): every item of the user, and the session if it is theirs. */
  async deleteAllForUser(userId: string): Promise<void> {
    assertUserId(userId);
    let session: StoredSession | null = null;
    try {
      session = await this.getSession();
    } catch (error) {
      if (!(error instanceof CorruptSecureItemError)) throw error;
      // A corrupt session item cannot be attributed to anyone; erasing removes it too.
      await this.deleteSession();
    }
    if (session?.user_id === userId) await this.deleteSession();
    await this.deleteDeviceKey(userId);
    await this.deleteIdentity(userId);
    await this.deleteDbKey(userId);
    await this.deleteBackupKey(userId);
  }
}

/**
 * RefreshTokenStore over `fixes.session`: the TokenManager persists every rotated refresh token here
 * before it uses the new access token.
 */
export class SessionRefreshTokenStore implements RefreshTokenStore {
  constructor(private readonly items: SecureItems) {}

  async getRefreshToken(): Promise<string | null> {
    return (await this.items.getSession())?.refresh_token ?? null;
  }

  async setRefreshToken(token: string): Promise<void> {
    const session = await this.items.getSession();
    if (!session) throw new Error('No session to update');
    await this.items.setSession({ ...session, refresh_token: token });
  }
}
