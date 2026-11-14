import { ApiError } from '../api/errors';
import type { DeviceInfo, UserDevicesResponse } from '../api/types';
import { fromBase64Exact } from '../crypto/encoding';
import { CryptoError } from '../crypto/errors';
import { verifyDeviceCertificate } from '../crypto/identity';
import type { LocalStore } from '../db/localStore';
import type { Clock } from '../platform';

/**
 * Trust decisions of protocol §8: which devices of a user may be encrypted to, and which sender
 * devices may be decrypted from. A device is eligible only when its certificate verifies under the
 * AIK pinned for its user (TOFU for contacts, the AIK this install holds for my devices).
 */

/** The endpoints the directory reads (ApiClient implements them). */
export interface DirectoryApi {
  getUserDevices(userId: string): Promise<UserDevicesResponse>;
  getUserDevice(userId: string, deviceId: string): Promise<DeviceInfo>;
}

export interface EligibleDevice {
  deviceId: string;
  publicKey: Uint8Array;
}

/**
 * - `pinned`: a key is pinned and `devices` are the devices it certifies;
 * - `pending`: the user changed their AIK and the change awaits the user's Accept (sending blocked);
 * - `none`: the user has no identity key yet (never linked a device).
 */
export type IdentityState = 'pinned' | 'pending' | 'none';

export interface DeviceList {
  userId: string;
  identity: IdentityState;
  devices: EligibleDevice[];
}

/** The sender device must not be trusted; the envelope is dropped (a permanent failure, §13). */
export class IneligibleSenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IneligibleSenderError';
  }
}

interface ReceiveKey {
  publicKey: Uint8Array;
  /** Envelopes created at or after this time are refused (§4.2). */
  revokedAtMs: number | null;
  /** Certified only by the contact's pending (not yet accepted) AIK. */
  viaPending: boolean;
  /** My own device, certified only by the account key the session reports (see OwnIdentityKeys). */
  viaAccountOnly: boolean;
}

/** A verified sender device (§4.2). */
export interface SenderKey {
  publicKey: Uint8Array;
  /** Accepted only through the contact's pending AIK: shown below the "safety code changed" warning (§8). */
  viaPending: boolean;
  /**
   * My own device certified only by the account key the server reports, not by the AIK this install
   * holds: trusted for the `link` and `history` transfer alone, which the QR secret authenticates (§7.3).
   */
  viaAccountOnly: boolean;
}

/** The keys my own devices are judged under (§8). */
export interface OwnIdentityKeys {
  /** The AIK this install holds; while it holds none, the account key the session reports. */
  trusted: Uint8Array | null;
  /** The session's account key when this install holds a different AIK; null otherwise. */
  accountOnly: Uint8Array | null;
}

interface CacheEntry {
  fetchedAt: number;
  pinned: Uint8Array | null;
  pending: Uint8Array | null;
  /** Own list only: OwnIdentityKeys.accountOnly. */
  accountOnly: Uint8Array | null;
  /** Certified by the pinned key: the devices to encrypt to. */
  eligible: EligibleDevice[];
  /** Devices accepted as senders: certified by the pinned, the pending or (own list) the account-only key (§8). */
  receive: Map<string, ReceiveKey>;
}

export interface DeviceDirectoryOptions {
  api: DirectoryApi;
  store: LocalStore;
  clock: Clock;
  self: { userId: string; deviceId: string };
  /**
   * The keys my own devices are judged under; a null `trusted` falls back to the key in the device
   * list. Devices certified only by `accountOnly` are accepted as senders with `viaAccountOnly` and
   * never encrypted to.
   */
  ownIdentityKeys: () => Promise<OwnIdentityKeys>;
  /** §8: device lists are cached for 60 s per user. */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 60_000;

/** How every §8 "safety code changed" system message ends (to find it again in a conversation). */
export const SAFETY_CODE_CHANGED_SUFFIX = 'safety code changed';

/** System message of §8 ("<username>'s safety code changed"). */
export function safetyCodeChangedText(username: string | null): string {
  return username ? `${username}'s ${SAFETY_CODE_CHANGED_SUFFIX}` : `This contact's ${SAFETY_CODE_CHANGED_SUFFIX}`;
}

/**
 * Definitive answers of the device endpoints (§5.3): the sender cannot be verified, ever. Anything
 * else (network, 5xx, 429, 401 after the refresh, proxy pages, malformed bodies) says nothing about
 * the sender and is retried.
 */
function isDefinitiveLookupRefusal(error: unknown): error is ApiError {
  if (!(error instanceof ApiError)) return false;
  return (
    ((error.code === 'not_friends' || error.code === 'forbidden') && error.status === 403) ||
    (error.code === 'not_found' && error.status === 404) ||
    (error.code === 'validation_error' && error.status === 422)
  );
}

function decodeKey(value: string | null | undefined): Uint8Array | null {
  if (typeof value !== 'string') return null;
  try {
    return fromBase64Exact(value, 32);
  } catch (error) {
    if (error instanceof CryptoError) return null;
    throw error;
  }
}

export class DeviceDirectory {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, { generation: number; promise: Promise<CacheEntry> }>();
  // Bumped by invalidate(): a fetch that started before an invalidation must not refill the cache.
  private readonly generations = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(private readonly options: DeviceDirectoryOptions) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  /** Eligible devices for encryption (my own current device excluded). */
  async devicesFor(userId: string, options: { refresh?: boolean } = {}): Promise<DeviceList> {
    const entry = await this.entry(userId, options.refresh === true);
    const identity: IdentityState = entry.pending ? 'pending' : entry.pinned ? 'pinned' : 'none';
    return { userId, identity, devices: entry.eligible };
  }

  /** §8 invalidation: `stale_devices`, `devices_changed` (own list), socket (re)connect (own list). */
  invalidate(...userIds: string[]): void {
    for (const userId of userIds) {
      this.cache.delete(userId);
      this.generations.set(userId, (this.generations.get(userId) ?? 0) + 1);
    }
  }

  invalidateAll(): void {
    this.invalidate(...new Set([...this.cache.keys(), ...this.inflight.keys()]));
  }

  /**
   * Public key of a sender device (§4.2): cached verified devices first, then
   * `GET /v1/users/{su}/devices/{sd}`. The certificate must verify under the pinned (or pending) AIK,
   * and a revoked device is accepted only for envelopes created before its revocation.
   * Throws IneligibleSenderError (permanent) or any other error unchanged (retried by the caller).
   */
  async resolveSender(userId: string, deviceId: string, createdAtMs: number): Promise<SenderKey> {
    const { self } = this.options;
    if (userId === self.userId && deviceId === self.deviceId) throw new IneligibleSenderError('Envelope from this device');
    try {
      // The cached list (refreshed when older than the TTL) bounds how long a revocation can go unnoticed.
      const cachedBefore = this.cache.get(userId);
      let entry = await this.entry(userId, false);
      let key: ReceiveKey | null | undefined = entry.receive.get(deviceId);
      if (!key && !entry.pinned) {
        entry = await this.entry(userId, true);
        key = entry.receive.get(deviceId);
      }
      if (!key) {
        const info = await this.fetchDevice(userId, deviceId);
        key = this.verifySingle(entry, userId, info);
        if (!key && entry === cachedBefore) {
          // The cached list predates something: typically an AIK change (identity reset), so the device is
          // certified by a key this entry has never seen. Reload once, which reconciles the pin (§8: the
          // new key becomes pending and its devices are accepted as senders), then judge again.
          entry = await this.entry(userId, true);
          key = entry.receive.get(deviceId) ?? this.verifySingle(entry, userId, info);
        }
        if (!key) throw new IneligibleSenderError('Sender device is not certified by the pinned identity key');
        entry.receive.set(deviceId, key);
      }
      if (key.revokedAtMs !== null && !(createdAtMs < key.revokedAtMs)) {
        throw new IneligibleSenderError('Envelope created after the sender device was revoked');
      }
      return { publicKey: key.publicKey, viaPending: key.viaPending, viaAccountOnly: key.viaAccountOnly };
    } catch (error) {
      // 403 not_friends, 404 not_found: this sender cannot be verified, ever (the envelope is dropped).
      if (isDefinitiveLookupRefusal(error)) throw new IneligibleSenderError(`Sender device lookup refused (${error.code})`);
      throw error;
    }
  }

  /** The user tapped Accept on the safety-code banner (§8): pin the pending key, unverified. */
  async acceptIdentityChange(userId: string): Promise<boolean> {
    const accepted = await this.options.store.contactIdentities.acceptPending(userId);
    this.invalidate(userId);
    return accepted;
  }

  // ---- internals ------------------------------------------------------------------------------

  private async entry(userId: string, refresh: boolean): Promise<CacheEntry> {
    const cached = this.cache.get(userId);
    if (!refresh && cached && this.options.clock.now() - cached.fetchedAt < this.ttlMs) return cached;
    const generation = this.generations.get(userId) ?? 0;
    const running = this.inflight.get(userId);
    if (running && running.generation === generation) return running.promise;
    const promise = this.load(userId).then(
      (entry) => {
        if ((this.generations.get(userId) ?? 0) === generation) this.cache.set(userId, entry);
        return entry;
      },
    );
    const flight = { generation, promise };
    this.inflight.set(userId, flight);
    const clear = () => {
      if (this.inflight.get(userId) === flight) this.inflight.delete(userId);
    };
    promise.then(clear, clear);
    return promise;
  }

  private async load(userId: string): Promise<CacheEntry> {
    const { api, self, clock } = this.options;
    const fetchedAt = clock.now();
    const response = await api.getUserDevices(userId);
    let pinned: Uint8Array | null;
    let pending: Uint8Array | null = null;
    let accountOnly: Uint8Array | null = null;
    if (userId === self.userId) {
      const own = await this.options.ownIdentityKeys();
      pinned = own.trusted ?? decodeKey(response.identity_key);
      accountOnly = own.accountOnly;
    } else {
      const pins = await this.reconcilePin(userId, response.identity_key);
      pinned = decodeKey(pins.pinned);
      pending = decodeKey(pins.pending);
    }
    const eligible: EligibleDevice[] = [];
    const receive = new Map<string, ReceiveKey>();
    for (const device of response.devices) {
      if (userId === self.userId && device.id === self.deviceId) continue;
      const publicKey = decodeKey(device.public_key);
      if (!publicKey) continue;
      const certified = (key: Uint8Array | null) =>
        key !== null &&
        verifyDeviceCertificate({
          identityPublicKey: key,
          userId,
          deviceId: device.id,
          devicePublicKey: publicKey,
          certificate: device.certificate,
        });
      if (certified(pinned)) {
        eligible.push({ deviceId: device.id, publicKey });
        receive.set(device.id, { publicKey, revokedAtMs: null, viaPending: false, viaAccountOnly: false });
      } else if (certified(pending)) {
        // Messages certified by the pending key are shown (below the warning), but nothing is sent to it.
        receive.set(device.id, { publicKey, revokedAtMs: null, viaPending: true, viaAccountOnly: false });
      } else if (certified(accountOnly)) {
        // Only the link transfer is taken from it (the server could have made this certificate).
        receive.set(device.id, { publicKey, revokedAtMs: null, viaPending: false, viaAccountOnly: true });
      }
    }
    return { fetchedAt, pinned, pending, accountOnly, eligible, receive };
  }

  /** TOFU pin on first sight; a different server key becomes `pending_identity_key` plus a system message. */
  private async reconcilePin(
    userId: string,
    serverKey: string | null,
  ): Promise<{ pinned: string | null; pending: string | null }> {
    const { store, clock } = this.options;
    const validServerKey = decodeKey(serverKey) ? serverKey : null;
    const existing = await store.contactIdentities.get(userId);
    if (!existing) {
      if (!validServerKey) return { pinned: null, pending: null };
      await store.contactIdentities.pinIfAbsent(userId, validServerKey, clock.now());
      // Another writer (an import) may have pinned first; the stored pin is what counts.
      const row = await store.contactIdentities.get(userId);
      return { pinned: row?.identity_key ?? validServerKey, pending: row?.pending_identity_key ?? null };
    }
    if (
      validServerKey &&
      validServerKey !== existing.identity_key &&
      validServerKey !== existing.pending_identity_key
    ) {
      const now = clock.now();
      await store.transaction(async (tx) => {
        if (await tx.contactIdentities.setPending(userId, validServerKey)) {
          const conversation = await tx.conversations.get(userId);
          const name = conversation?.peer_username;
          await tx.messages.insertSystem(userId, safetyCodeChangedText(name ?? null), now);
        }
      });
      return { pinned: existing.identity_key, pending: validServerKey };
    }
    return { pinned: existing.identity_key, pending: existing.pending_identity_key };
  }

  /** §4.2 fallback: one device in any state (revoked ones included). */
  private async fetchDevice(userId: string, deviceId: string): Promise<DeviceInfo> {
    const info = await this.options.api.getUserDevice(userId, deviceId);
    if (info.id !== deviceId || info.user_id !== userId) throw new IneligibleSenderError('Device belongs to someone else');
    return info;
  }

  /** The device's receive key if its certificate verifies under the entry's pinned, pending or account-only AIK, else null. */
  private verifySingle(entry: CacheEntry, userId: string, info: DeviceInfo): ReceiveKey | null {
    const publicKey = decodeKey(info.public_key);
    if (!publicKey) throw new IneligibleSenderError('Invalid device public key');
    const certified = (key: Uint8Array | null) =>
      key !== null &&
      verifyDeviceCertificate({
        identityPublicKey: key,
        userId,
        deviceId: info.id,
        devicePublicKey: publicKey,
        certificate: info.certificate,
      });
    const viaPinned = certified(entry.pinned);
    const viaPending = !viaPinned && certified(entry.pending);
    const viaAccountOnly = !viaPinned && !viaPending && certified(entry.accountOnly);
    if (!viaPinned && !viaPending && !viaAccountOnly) return null;
    const revokedAtMs = info.revoked_at === null ? null : Date.parse(info.revoked_at);
    if (revokedAtMs !== null && Number.isNaN(revokedAtMs)) throw new IneligibleSenderError('Invalid revocation time');
    return { publicKey, revokedAtMs, viaPending, viaAccountOnly };
  }
}
