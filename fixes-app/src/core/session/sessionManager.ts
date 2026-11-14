import { createApiStack, type ApiClient } from '../api';
import { ApiError, isSignedOutError, isTransientError } from '../api/errors';
import type { SignedOutReason, TokenManager } from '../api/tokens';
import type { Me, MyDevice, User } from '../api/types';
import type { ApiConfig } from '../config';
import { generateDeviceKeyPair, type DeviceKeyPair } from '../crypto/deviceKeys';
import { bytesEqual, fromBase64Exact, toBase64 } from '../crypto/encoding';
import { EnvelopeKeyCache } from '../crypto/envelope';
import { CryptoError } from '../crypto/errors';
import {
  generateIdentityKeyPair,
  identityKeyPairMatches,
  signDeviceCertificate,
  verifyDeviceCertificate,
  type IdentityKeyPair,
} from '../crypto/identity';
import { randomFloat, selfTestRandom } from '../crypto/random';
import type { LocalStore } from '../db/localStore';
import type { Unsubscribe } from '../events';
import {
  systemClock,
  type Clock,
  type DatabaseOpener,
  type FetchLike,
  type HttpUpload,
  type SecureKeyValueStore,
  type WebSocketFactory,
} from '../platform';
import { backoffDelay } from '../realtime/backoff';
import { RealtimeSocket } from '../realtime/socket';
import { SerialQueue } from '../utils/serialQueue';
import { assertCredentials, InputValidationError, isValidPassword, normalizeDeviceName } from '../utils/validation';
import { openLocalStore } from './localDatabase';
import { CorruptSecureItemError, SecureItems, SessionRefreshTokenStore } from './secureItems';

export type SessionStatus = 'loading' | 'signedOut' | 'needsLink' | 'ready';
export type SignedOutCause = 'logout' | 'erased' | SignedOutReason;

export interface SessionState {
  status: SessionStatus;
  user: Me | null;
  /** This device as the server reports it (certificate set once linked). */
  device: MyDevice | null;
  /** status 'loading': the server was unreachable; retried automatically with backoff. */
  offline: boolean;
  /** status 'loading': a non-network failure (safe to show); `retry()` tries again. */
  error: string | null;
  /** status 'signedOut': why the previous session ended; null on a fresh start. */
  signedOutReason: SignedOutCause | null;
  /** The local database file had no key and was moved aside (§12.1): offer backup import / linking. */
  localDataReset: boolean;
}

/**
 * Work that must finish before the server logout (protocol §13: drain the mailbox, flush the outbox).
 * Registered by the messaging engine (part 2). Throwing aborts the logout.
 */
export type LogoutHook = () => Promise<void>;

export interface SessionManagerOptions {
  config: ApiConfig;
  secureStore: SecureKeyValueStore;
  databases: DatabaseOpener;
  /** Sent as the device name at login (1–64 characters). */
  deviceName: string;
  upload?: HttpUpload | null;
  fetch?: FetchLike;
  clock?: Clock;
  /** Uniform [0, 1) source for retry jitter; defaults to crypto.getRandomValues. */
  random?: () => number;
}

/** The device-local identity of the signed-in session, for the messaging engine. */
export interface ActiveDevice {
  userId: string;
  deviceId: string;
  keys: DeviceKeyPair;
}

const INITIAL_STATE: SessionState = {
  status: 'loading',
  user: null,
  device: null,
  offline: false,
  error: null,
  signedOutReason: null,
  localDataReset: false,
};

/**
 * Framework-agnostic session lifecycle: register, login with the §9 step-1 linking decision, restore on
 * launch, logout, erase, identity reset and DB key management. Observable for React through
 * `subscribe`/`getState` (useSyncExternalStore-compatible).
 *
 * State transitions run one at a time on an internal queue. `generation` changes whenever a session
 * ends, so work that started for an older session can never touch the current one.
 */
export class SessionManager {
  readonly api: ApiClient;
  readonly tokens: TokenManager;
  readonly items: SecureItems;
  /** Shared derived-key cache for envelope crypto; cleared on sign-out. */
  readonly envelopeKeys = new EnvelopeKeyCache();
  private state: SessionState = INITIAL_STATE;
  private readonly listeners = new Set<(state: SessionState) => void>();
  private readonly ops = new SerialQueue();
  private readonly logoutHooks = new Set<LogoutHook>();
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly deviceName: string;
  private active: ActiveDevice | null = null;
  private store: LocalStore | null = null;
  private generation = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  /**
   * The AIK of a resetIdentity call whose outcome is unknown (network error): the server may have
   * applied it. A later reset sends this key again, so a repeated tap never rotates the account key
   * twice. Only a key this session generated for a reset, never an older stored AIK.
   */
  private pendingResetIdentity: IdentityKeyPair | null = null;
  private readonly unsubscribeTokens: Unsubscribe;

  constructor(private readonly options: SessionManagerOptions) {
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? randomFloat;
    this.deviceName = normalizeDeviceName(options.deviceName);
    this.items = new SecureItems(options.secureStore);
    const stack = createApiStack({
      apiBaseUrl: options.config.apiBaseUrl,
      refreshTokens: new SessionRefreshTokenStore(this.items),
      fetch: options.fetch,
      upload: options.upload,
      clock: this.clock,
    });
    this.api = stack.api;
    this.tokens = stack.tokens;
    this.unsubscribeTokens = this.tokens.events.on('signedOut', ({ reason }) => {
      // Without an active session there is nothing to end (and the existing reason must stay).
      if (!this.active) return;
      const generation = this.generation;
      void this.ops
        .run(async () => {
          if (generation === this.generation) await this.localSignOut(reason);
        })
        .catch((error: unknown) => console.error('Signing out after token revocation failed', error));
    });
  }

  // ---- Observation --------------------------------------------------------------------------

  getState(): SessionState {
    return this.state;
  }

  subscribe(listener: (state: SessionState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The open local database; only while status is 'needsLink' or 'ready'. */
  getLocalStore(): LocalStore {
    if (!this.store) throw new Error('No local database is open');
    return this.store;
  }

  getActiveDevice(): ActiveDevice | null {
    return this.active;
  }

  /** This account's AIK if this install holds it (linked devices always do once linking completed). */
  async getIdentity(): Promise<IdentityKeyPair | null> {
    if (!this.active) return null;
    return this.readIdentity(this.active.userId);
  }

  /** Socket bound to this session's tokens (part 2 starts/stops it with the session state). */
  createSocket(factory: WebSocketFactory): RealtimeSocket {
    return new RealtimeSocket({ url: this.options.config.wsUrl, factory, tokens: this.tokens });
  }

  /** Part 2 registers the drain/flush step of §13 here. */
  addLogoutHook(hook: LogoutHook): Unsubscribe {
    this.logoutHooks.add(hook);
    return () => {
      this.logoutHooks.delete(hook);
    };
  }

  // ---- Lifecycle ----------------------------------------------------------------------------

  /** App launch: RNG self-test (§2), then restore the stored session if any. */
  async start(): Promise<void> {
    selfTestRandom();
    await this.ops.run(() => this.restore());
  }

  /** Manual retry after an offline/error state. */
  retry(): Promise<void> {
    return this.ops.run(async () => {
      this.cancelRetry();
      if (this.active) await this.activate(this.generation);
      else await this.restore();
    });
  }

  /**
   * Re-reads the account and device from the server, e.g. after `devices_changed` while waiting to be
   * linked. For a running session (needsLink/ready) a failure keeps the current state: it never sends
   * the app back to the startup screen, and while not linked it is retried quietly.
   */
  refreshLinkState(): Promise<void> {
    return this.ops.run(async () => {
      if (!this.active) return;
      if (this.isRunning()) await this.recheckLinkState(this.generation);
      else await this.activate(this.generation);
    });
  }

  /**
   * The account changed on the server in a way the app caused (e.g. `PUT /v1/users/me/avatar` returned
   * it): takes its profile fields into the state. The identity key is never changed this way; only the
   * §9 decision may change it.
   */
  updateUser(user: Me): Promise<void> {
    return this.ops.run(async () => {
      const current = this.state.user;
      if (!this.active || user.id !== this.active.userId || !this.isRunning() || current?.id !== user.id) return;
      this.setState({ ...this.state, user: { ...current, username: user.username, avatar_url: user.avatar_url } });
    });
  }

  dispose(): void {
    this.cancelRetry();
    this.unsubscribeTokens();
    this.listeners.clear();
  }

  // ---- Account actions ----------------------------------------------------------------------

  /** Creates the account. The UI shows the welcome toast and then calls login() (§14). */
  async register(username: string, password: string): Promise<User> {
    assertCredentials(username, password);
    return (await this.api.register(username, password)).user;
  }

  /**
   * Logs in as a new device. Errors before the session is stored (wrong password, offline, too many
   * devices…) are thrown; later failures are reported through the state and retried.
   */
  login(username: string, password: string): Promise<void> {
    return this.ops.run(async () => {
      assertCredentials(username, password);
      if (this.active) throw new Error('Already signed in; log out first');
      // The device key exists before the server hears about the device (§9).
      const keys = generateDeviceKeyPair();
      const publicKeyB64 = toBase64(keys.publicKey);
      const response = await this.api.login(username, password, { name: this.deviceName, public_key: publicKeyB64 });
      if (response.device.public_key !== publicKeyB64) {
        throw new ApiError({ status: 200, code: 'invalid_response', message: 'The server registered a different device key' });
      }
      const userId = response.user.id;
      // Device key first: a session without its device key would be unusable.
      await this.items.setDeviceKey(userId, response.device.id, keys);
      await this.items.setSession({ user_id: userId, device_id: response.device.id, refresh_token: response.refresh_token });
      const generation = this.beginSession({ userId, deviceId: response.device.id, keys });
      this.tokens.setTokens(response);
      await this.activate(generation, { me: response.user, device: response.device });
    });
  }

  /**
   * Logout (§13): run the registered drain/flush hooks, revoke this device on the server, then delete
   * `fixes.session` and `fixes.device.<user_id>`. Local data (DB, DB key, identity, recovery key) stays.
   * Requires connectivity; a network error leaves the session untouched.
   */
  logout(): Promise<void> {
    return this.ops.run(async () => {
      this.requireActive();
      for (const hook of [...this.logoutHooks]) await hook();
      try {
        await this.api.logout();
      } catch (error) {
        // Already revoked on the server: the goal of the call is met, finish locally.
        if (!isSignedOutError(error)) throw error;
      }
      await this.localSignOut('logout');
    });
  }

  /**
   * Erase this device (§12.1): revoke it on the server when reachable, then delete the DB file and every
   * secure-storage item of the user. Erasure never waits for connectivity; `serverRevoked: false` tells
   * the UI to warn that the device is still listed until revoked from another device or idle-swept.
   */
  eraseDevice(): Promise<{ serverRevoked: boolean }> {
    return this.ops.run(async () => {
      const { userId } = this.requireActive();
      let serverRevoked = false;
      try {
        await this.api.logout();
        serverRevoked = true;
      } catch (error) {
        if (isSignedOutError(error)) serverRevoked = true;
        else console.warn('Could not revoke the device on the server while erasing', error);
      }
      this.endSession();
      await this.closeStore();
      await this.options.databases.delete(userId);
      await this.items.deleteAllForUser(userId);
      this.setState({ ...INITIAL_STATE, status: 'signedOut', signedOutReason: 'erased' });
      return { serverRevoked };
    });
  }

  /**
   * "I lost my other devices" (§9 step 1): new AIK, certificate for this device, `POST /v1/auth/reset-identity`.
   * Only from the needsLink state. After an attempt with an unknown outcome the next one reuses its key:
   * if the server had applied it, the repeated reset changes nothing for contacts.
   */
  resetIdentity(password: string): Promise<void> {
    return this.ops.run(async () => {
      const active = this.requireActive();
      const device = this.state.device;
      if (this.state.status !== 'needsLink' || !device) throw new Error('Identity reset is only possible while not linked');
      if (!isValidPassword(password)) throw new InputValidationError('password', 'Passwords have 8 to 128 characters.');
      const generation = this.generation;
      const previous = await this.items.getIdentityRaw(active.userId);
      const identity = this.pendingResetIdentity ?? generateIdentityKeyPair();
      // Stored before the call: if the server accepts and the app dies, the new key must not be lost.
      await this.items.setIdentity(active.userId, identity);
      const certificate = signDeviceCertificate(identity, active.userId, active.deviceId, active.keys.publicKey);
      let user: Me;
      try {
        user = (await this.api.resetIdentity(password, toBase64(identity.publicKey), certificate)).user;
      } catch (error) {
        // A definitive rejection means the server kept its key: put the previous local item back (the key
        // of an earlier attempt with an unknown outcome stays pending). After a network error the outcome
        // is unknown, so the new key is kept, reused by the next attempt, and the link state is re-checked
        // quietly: the `devices_changed` of a reset the server did apply may never arrive.
        if (!isTransientError(error)) await this.restoreIdentityItem(active.userId, previous);
        else if (generation === this.generation) {
          this.pendingResetIdentity = identity;
          this.scheduleRetry(generation);
        }
        throw error;
      }
      this.pendingResetIdentity = null;
      if (generation !== this.generation) return;
      requireAccountKey(user, identity.publicKey);
      this.setLinked(user, { ...device, certificate });
    });
  }

  /**
   * Stores the AIK received in a `link` transfer (§7.3, part 2) after checking it is the account's
   * current identity key and a matching pair.
   */
  adoptIdentity(identity: IdentityKeyPair): Promise<void> {
    return this.ops.run(async () => {
      const active = this.requireActive();
      const serverKey = this.state.user?.identity_key;
      if (!serverKey || !bytesEqual(fromBase64Exact(serverKey, 32), identity.publicKey)) {
        throw new Error('The transferred identity key is not the account identity key');
      }
      if (!identityKeyPairMatches(identity.secretKey, identity.publicKey)) {
        throw new Error('The transferred identity secret does not match its public key');
      }
      await this.items.setIdentity(active.userId, identity);
    });
  }

  // ---- Internals ----------------------------------------------------------------------------

  private async restore(): Promise<void> {
    this.cancelRetry();
    let session;
    try {
      session = await this.items.getSession();
    } catch (error) {
      if (!(error instanceof CorruptSecureItemError)) throw error;
      console.warn('Discarding a corrupt session item');
      await this.items.deleteSession();
      session = null;
    }
    if (!session) {
      this.setState({ ...INITIAL_STATE, status: 'signedOut' });
      return;
    }
    let deviceKey;
    try {
      deviceKey = await this.items.getDeviceKey(session.user_id);
    } catch (error) {
      if (!(error instanceof CorruptSecureItemError)) throw error;
      console.warn('Discarding a session whose device key is corrupt');
      deviceKey = null;
    }
    if (!deviceKey || deviceKey.deviceId !== session.device_id) {
      // Without its own device key the session cannot decrypt anything; start over with a fresh login.
      await this.items.deleteSession();
      await this.items.deleteDeviceKey(session.user_id);
      this.setState({ ...INITIAL_STATE, status: 'signedOut' });
      return;
    }
    const generation = this.beginSession({ userId: session.user_id, deviceId: session.device_id, keys: deviceKey.keys });
    await this.activate(generation);
  }

  /** Loads account + device (unless given), opens the DB and applies the §9 step-1 decision. */
  private async activate(generation: number, known?: { me: Me; device: MyDevice }): Promise<void> {
    const active = this.active;
    if (!active || generation !== this.generation) return;
    try {
      const { me, device } = known ?? (await this.fetchAccount(active));
      if (generation !== this.generation) return;
      assertListsThisDevice(active, me, device);
      if (!this.store) {
        const opened = await openLocalStore(active.userId, this.items, this.options.databases);
        if (generation !== this.generation) {
          await opened.store.close();
          return;
        }
        this.store = opened.store;
        if (opened.movedAside) this.state = { ...this.state, localDataReset: true };
      }
      await this.decideLinkState(generation, active, me, device);
      this.retryAttempt = 0;
    } catch (error) {
      await this.handleActivationError(error, generation);
    }
  }

  /**
   * refreshLinkState for a running session (needsLink/ready): the same §9 decision as activate(), but a
   * failure keeps the current status, user and device, so the messaging runtime and the screen stay.
   * While not linked it is retried quietly with backoff.
   */
  private async recheckLinkState(generation: number): Promise<void> {
    const active = this.active;
    if (!active || generation !== this.generation) return;
    try {
      const { me, device } = await this.fetchAccount(active);
      if (generation !== this.generation) return;
      assertListsThisDevice(active, me, device);
      await this.decideLinkState(generation, active, me, device);
      // A quiet retry still scheduled by an earlier failure has nothing left to do.
      this.cancelRetry();
      this.retryAttempt = 0;
    } catch (error) {
      if (generation !== this.generation) return;
      if (isSignedOutError(error)) {
        await this.localSignOut(error.code as SignedOutReason);
        return;
      }
      console.warn('Could not refresh the link state; keeping the current state', error);
      if (this.state.status === 'needsLink') this.scheduleRetry(generation);
    }
  }

  private async fetchAccount(active: ActiveDevice): Promise<{ me: Me; device: MyDevice | undefined }> {
    const me = await this.api.getMe();
    const device = (await this.api.listMyDevices()).devices.find((d) => d.id === active.deviceId);
    return { me, device };
  }

  /** Protocol §9 step 1. */
  private async decideLinkState(generation: number, active: ActiveDevice, me: Me, device: MyDevice): Promise<void> {
    if (me.identity_key === null) {
      if (await this.publishIdentity(generation, active, me, device)) return;
      // Another device won the race to create the identity; continue as a later device.
      me = await this.api.getMe();
      if (generation !== this.generation) return;
    }
    const local = await this.readIdentity(me.id);
    const accountKey = me.identity_key === null ? null : fromBase64Exact(me.identity_key, 32);
    if (accountKey !== null && local && !bytesEqual(local.publicKey, accountKey)) {
      // This install holds another AIK than the one the server reports: a stale item (the identity was
      // reset elsewhere) or a server substituting its own key. A certificate under the server's key
      // proves nothing then (the server can make one), so the device stays unlinked until a `link`
      // transfer replaces the item with the account key (§9). Safety codes and own-device checks use
      // this install's AIK, never the server's word.
      this.setNeedsLink(generation, me, device);
      return;
    }
    if (accountKey !== null && this.isCertified(me, accountKey, device, active)) {
      this.setLinked(me, device);
      return;
    }
    if (accountKey !== null && local) {
      // Re-login on the same install: the stored AIK (checked above to be the account key) certifies
      // the new device itself.
      const certificate = signDeviceCertificate(local, me.id, device.id, active.keys.publicKey);
      const updated = await this.api.putDeviceCertificate(device.id, certificate);
      if (generation === this.generation) this.setLinked(me, updated);
      return;
    }
    this.setNeedsLink(generation, me, device);
  }

  /**
   * §9 step 1 for an account without an identity key (its first device): publishes this install's AIK
   * when it holds one, so a key that contacts pinned is never replaced (e.g. after a server restore),
   * else a new one. Returns false when another device published first (`identity_exists`).
   */
  private async publishIdentity(generation: number, active: ActiveDevice, me: Me, device: MyDevice): Promise<boolean> {
    let identity = await this.readIdentity(me.id);
    // The item as it was before a new key replaced it; undefined while it was not replaced.
    let previous: string | null | undefined;
    if (!identity) {
      previous = await this.items.getIdentityRaw(me.id);
      identity = generateIdentityKeyPair();
      // Stored before the call: if the server accepts and the app dies, the new key must not be lost.
      await this.items.setIdentity(me.id, identity);
    }
    const certificate = signDeviceCertificate(identity, me.id, device.id, active.keys.publicKey);
    let user: Me;
    try {
      user = (await this.api.putIdentity(toBase64(identity.publicKey), certificate)).user;
    } catch (error) {
      // A definitive refusal (identity_exists included) means the server did not take the new key: put
      // the previous item back, as resetIdentity does. After a network error the outcome is unknown.
      if (previous !== undefined && !isTransientError(error)) await this.restoreIdentityItem(me.id, previous);
      if (error instanceof ApiError && error.code === 'identity_exists') return false;
      throw error;
    }
    if (generation !== this.generation) return true;
    requireAccountKey(user, identity.publicKey);
    this.setLinked(user, { ...device, certificate });
    return true;
  }

  /** Puts the identity item back as it was before a replacement the server refused (null: there was none). */
  private async restoreIdentityItem(userId: string, previous: string | null): Promise<void> {
    if (previous === null) await this.items.deleteIdentity(userId);
    else await this.items.setIdentityRaw(userId, previous);
  }

  private isCertified(me: Me, identityPublicKey: Uint8Array, device: MyDevice, active: ActiveDevice): boolean {
    return verifyDeviceCertificate({
      identityPublicKey,
      userId: me.id,
      deviceId: device.id,
      devicePublicKey: active.keys.publicKey,
      certificate: device.certificate,
    });
  }

  private async readIdentity(userId: string): Promise<IdentityKeyPair | null> {
    try {
      return await this.items.getIdentity(userId);
    } catch (error) {
      if (!(error instanceof CorruptSecureItemError)) throw error;
      // An unreadable identity is as good as none: the device goes through linking again.
      console.warn('Ignoring a corrupt identity item');
      return null;
    }
  }

  private async handleActivationError(error: unknown, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    if (isSignedOutError(error)) {
      await this.localSignOut(error.code as SignedOutReason);
      return;
    }
    if (isTransientError(error)) {
      this.setState({ ...this.state, status: 'loading', offline: true, error: null });
      this.scheduleRetry(generation);
      return;
    }
    console.error('Session activation failed', error);
    const message = error instanceof Error ? error.message : 'Unexpected error';
    this.setState({ ...this.state, status: 'loading', offline: false, error: message });
  }

  private scheduleRetry(generation: number): void {
    this.cancelRetry();
    const delay = backoffDelay(this.retryAttempt++, this.random);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.ops
        .run(() => {
          if (generation !== this.generation) return Promise.resolve();
          // A running session retries its quiet re-check; otherwise the startup activation.
          return this.isRunning() ? this.recheckLinkState(generation) : this.activate(generation);
        })
        .catch((error: unknown) => console.error('Session retry failed', error));
    }, delay);
  }

  private cancelRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private beginSession(active: ActiveDevice): number {
    this.generation++;
    this.active = active;
    this.retryAttempt = 0;
    this.setState({ ...INITIAL_STATE, status: 'loading' });
    return this.generation;
  }

  /** Forgets in-memory session state; every pending continuation of the old generation becomes a no-op. */
  private endSession(): void {
    this.generation++;
    this.active = null;
    this.pendingResetIdentity = null;
    this.cancelRetry();
    this.tokens.clear();
    this.envelopeKeys.clear();
  }

  private async closeStore(): Promise<void> {
    const store = this.store;
    this.store = null;
    if (store) await store.close();
  }

  /** Sign-out that keeps local data: deletes `fixes.session` and the device key (§6, §13). */
  private async localSignOut(reason: SignedOutCause): Promise<void> {
    const active = this.active;
    this.endSession();
    // State first so the UI stops reading the database before it is closed.
    this.setState({ ...INITIAL_STATE, status: 'signedOut', signedOutReason: reason });
    try {
      await this.items.deleteSession();
      if (active) await this.items.deleteDeviceKey(active.userId);
    } finally {
      await this.closeStore();
    }
  }

  private setLinked(user: Me, device: MyDevice): void {
    // Linked: no identity reset is pending any more.
    this.pendingResetIdentity = null;
    this.setState({ ...this.state, status: 'ready', user, device, offline: false, error: null, signedOutReason: null });
  }

  private setNeedsLink(generation: number, user: Me, device: MyDevice): void {
    if (generation !== this.generation) return;
    this.setState({ ...this.state, status: 'needsLink', user, device, offline: false, error: null, signedOutReason: null });
  }

  /** needsLink or ready: the database is open and the messaging runtime runs. */
  private isRunning(): boolean {
    return this.state.status === 'needsLink' || this.state.status === 'ready';
  }

  private requireActive(): ActiveDevice {
    if (!this.active) throw new Error('Not signed in');
    return this.active;
  }

  private setState(next: SessionState): void {
    this.state = next;
    for (const listener of [...this.listeners]) {
      try {
        listener(next);
      } catch (error) {
        console.error('Session state listener failed', error);
      }
    }
  }
}

function assertListsThisDevice(active: ActiveDevice, me: Me, device: MyDevice | undefined): asserts device is MyDevice {
  if (me.id !== active.userId || !device || device.public_key !== toBase64(active.keys.publicKey)) {
    throw new ApiError({ status: 200, code: 'invalid_response', message: 'The server does not list this device' });
  }
}

/** After this device published an AIK, the server must report exactly that key as the account key. */
function requireAccountKey(user: Me, identityPublicKey: Uint8Array): void {
  let reported: Uint8Array | null = null;
  try {
    reported = user.identity_key === null ? null : fromBase64Exact(user.identity_key, 32);
  } catch (error) {
    if (!(error instanceof CryptoError)) throw error;
  }
  if (!reported || !bytesEqual(reported, identityPublicKey)) {
    throw new ApiError({ status: 200, code: 'invalid_response', message: 'The server reported another identity key' });
  }
}
