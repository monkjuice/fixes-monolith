import type { ApiClient } from '../api/client';
import { isSignedOutError } from '../api/errors';
import { bytesEqual, fromBase64Exact } from '../crypto/encoding';
import type { EnvelopeKeyCache } from '../crypto/envelope';
import type { IdentityKeyPair } from '../crypto/identity';
import type { LocalStore } from '../db/localStore';
import type { Unsubscribe } from '../events';
import { IncomingTransfers } from '../linking/incoming';
import { OutgoingLink } from '../linking/outgoing';
import type { Logger } from '../logger';
import type { Clock, WebSocketFactory } from '../platform';
import type { RealtimeSocket, SocketStatus } from '../realtime/socket';
import type { SecureItems } from '../session/secureItems';
import type { ActiveDevice, LogoutHook, SessionState } from '../session/sessionManager';
import { DeviceDirectory, type OwnIdentityKeys } from '../trust/deviceDirectory';
import { EnvelopeCodec } from './envelopeCodec';
import { EnvelopeProcessor } from './envelopeProcessor';
import { OutboxWorker } from './outboxWorker';
import { PeerProfiles } from './peerProfiles';
import { ReceiveQueue } from './receiveQueue';
import type { MessagingTimings } from './timings';

/** What the engine needs from the session layer (SessionManager implements it). */
export interface MessagingSession {
  readonly api: ApiClient;
  readonly items: SecureItems;
  readonly envelopeKeys: EnvelopeKeyCache;
  getState(): SessionState;
  subscribe(listener: (state: SessionState) => void): Unsubscribe;
  getLocalStore(): LocalStore;
  getActiveDevice(): ActiveDevice | null;
  getIdentity(): Promise<IdentityKeyPair | null>;
  createSocket(factory: WebSocketFactory): RealtimeSocket;
  addLogoutHook(hook: LogoutHook): Unsubscribe;
  refreshLinkState(): Promise<void>;
  logout(): Promise<void>;
}

/** 'linking': signed in but not linked yet (receives the link transfer); 'ready': full messaging. */
export type RuntimeMode = 'linking' | 'ready';

export interface RuntimeOptions {
  session: MessagingSession;
  socketFactory: WebSocketFactory;
  clock: Clock;
  random: () => number;
  logger: Logger;
  timings: MessagingTimings;
  onConnection(status: SocketStatus): void;
  onSyncing(syncing: boolean): void;
  onGap(): void;
}

/**
 * Everything that lives for one signed-in device: socket, device directory, receive queue, outbox
 * worker, peer profiles and the two sides of linking. Created when the session reaches `needsLink`
 * or `ready`, stopped when it ends; it never outlives the session's database.
 */
export class MessagingRuntime {
  readonly userId: string;
  readonly deviceId: string;
  readonly directory: DeviceDirectory;
  readonly codec: EnvelopeCodec;
  readonly receiver: ReceiveQueue;
  readonly outbox: OutboxWorker;
  readonly profiles: PeerProfiles;
  readonly incoming: IncomingTransfers;
  readonly outgoing: OutgoingLink;
  private readonly socket: RealtimeSocket;
  private readonly subscriptions: Unsubscribe[] = [];
  /** This install's AIK public key as last read from secure storage (null: none, or not read yet). */
  private ownIdentity: Uint8Array | null = null;
  /** The account key (session state) `ownIdentity` was read for, and a counter that voids older reads. */
  private identityReadFor: string | null = null;
  private identityReads = 0;
  /** The latest read of `ownIdentity` (never rejects). */
  private identityRead: Promise<void> = Promise.resolve();
  private expiryTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private currentMode: RuntimeMode;

  constructor(
    private readonly options: RuntimeOptions,
    active: ActiveDevice,
    readonly store: LocalStore,
    mode: RuntimeMode,
  ) {
    const { session, clock, logger, timings } = options;
    this.userId = active.userId;
    this.deviceId = active.deviceId;
    this.currentMode = mode;
    const self = { userId: active.userId, deviceId: active.deviceId };

    this.directory = new DeviceDirectory({
      api: session.api,
      store,
      clock,
      self,
      ownIdentityKeys: () => this.ownIdentityKeys(),
      ttlMs: timings.deviceCacheTtlMs,
    });
    this.codec = new EnvelopeCodec({ ...self, keys: active.keys }, session.envelopeKeys);
    this.profiles = new PeerProfiles({
      api: session.api,
      store,
      clock,
      logger,
      minIntervalMs: timings.peerRefreshIntervalMs,
    });
    this.incoming = new IncomingTransfers({
      store,
      clock,
      logger,
      self: { ...self, publicKey: active.keys.publicKey },
      firstChunkTimeoutMs: timings.transferFirstChunkMs,
      inactivityTimeoutMs: timings.transferInactivityMs,
      identity: {
        accountIdentityKey: () => session.getState().user?.identity_key ?? null,
        storeIdentity: (identity) => this.storeIdentity(identity),
        // Only an unlinked device needs the re-check; a linked one (e.g. "Receive history") already is.
        identityStored: () => {
          if (this.currentMode === 'linking') this.refreshLinkState();
        },
      },
      onCompleted: (peers) => this.profiles.fetchInBackground(peers),
    });
    const processor = new EnvelopeProcessor({
      store,
      directory: this.directory,
      codec: this.codec,
      self,
      transfers: this.incoming,
      clock,
      logger,
      receiptDebounceMs: timings.receiptDebounceMs,
    });
    this.receiver = new ReceiveQueue({
      api: session.api,
      processor,
      logger,
      random: options.random,
      pageSize: timings.pageSize,
      backoff: timings.receiveBackoff,
      onGap: () => options.onGap(),
      onSyncing: (syncing) => options.onSyncing(syncing),
      onProcessed: (result) => {
        if (result.queuedReceipts) this.outbox.kick();
        if (result.newPeers.length > 0) this.profiles.fetchInBackground(result.newPeers);
      },
    });
    this.outbox = new OutboxWorker({
      store,
      api: session.api,
      directory: this.directory,
      codec: this.codec,
      self,
      clock,
      random: options.random,
      logger,
      backoff: timings.outboxBackoff,
    });
    this.outgoing = new OutgoingLink({
      api: session.api,
      store,
      directory: this.directory,
      codec: this.codec,
      self,
      logger,
      getIdentity: () => session.getIdentity(),
      drainMailbox: () => this.receiver.drain(),
      batchSize: timings.historyBatchSize,
    });
    this.socket = session.createSocket(options.socketFactory);
  }

  get mode(): RuntimeMode {
    return this.currentMode;
  }

  start(): void {
    const { session, clock, logger, timings } = this.options;
    const events = this.socket.events;
    this.subscriptions.push(
      events.on('status', ({ status }) => this.options.onConnection(status)),
      events.on('ready', ({ gap }) => {
        // §8: the own device list is refreshed on every (re)connect.
        this.directory.invalidate(this.userId);
        this.receiver.onReady(gap);
        this.outbox.kick({ retryNow: true });
      }),
      events.on('envelope', ({ envelope }) => this.receiver.onPush(envelope)),
      events.on('devices_changed', () => {
        this.directory.invalidate(this.userId);
        // Waiting to be linked: another device may just have certified this one.
        if (this.currentMode === 'linking') this.refreshLinkState();
      }),
      events.on('protocolError', ({ message }) => logger.warn(`Realtime protocol error: ${message}`)),
      session.subscribe((state) => {
        // The account key changed (identity reset, link): the AIK this install holds may have too.
        if (!this.stopped && (state.user?.identity_key ?? null) !== this.identityReadFor) this.reloadIdentity();
      }),
    );
    this.socket.start();

    this.reloadIdentity();
    this.store.receiptHints
      .pruneOlderThan(clock.now() - timings.receiptHintTtlMs)
      .catch((error: unknown) => this.report('Could not prune receipt hints', error));
    this.expiryTimer = setInterval(() => {
      this.incoming.expireStale().catch((error: unknown) => this.report('Could not expire link transfers', error));
    }, timings.transferCheckIntervalMs);
    if (this.currentMode === 'ready') this.outbox.start();
  }

  setMode(mode: RuntimeMode): void {
    if (mode === this.currentMode) return;
    this.currentMode = mode;
    if (mode === 'ready') this.outbox.start();
    else this.outbox.stop();
  }

  /** App returned to the foreground (§6 4409 rule, §13 "runs on foreground"). */
  onForeground(): void {
    this.socket.resume();
    this.outbox.kick({ retryNow: true });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.expiryTimer = null;
    this.socket.stop();
    this.receiver.stop();
    this.outbox.stop();
    this.profiles.stop();
    this.outgoing.dispose();
  }

  /**
   * §8: my own devices are judged under this install's AIK; only an install that holds none (a new
   * device) trusts the account key the session reports. When the two differ (a stale item after an
   * identity reset elsewhere, or a server substituting its own key), a device certified only under the
   * session's key may still deliver the `link` transfer, whose payload is checked against that key and
   * authenticated by the QR secret (§7.3), but never sync copies or read syncs: the server could have
   * made its certificate. Never answered while a read of the stored AIK is still running.
   */
  private async ownIdentityKeys(): Promise<OwnIdentityKeys> {
    let read: Promise<void>;
    do {
      read = this.identityRead;
      await read;
    } while (read !== this.identityRead);
    const local = this.ownIdentity;
    const account = this.accountIdentityKey();
    if (!local) return { trusted: account, accountOnly: null };
    return { trusted: local, accountOnly: account && !bytesEqual(local, account) ? account : null };
  }

  private accountIdentityKey(): Uint8Array | null {
    const fromServer = this.options.session.getState().user?.identity_key;
    if (!fromServer) return null;
    try {
      return fromBase64Exact(fromServer, 32);
    } catch (error) {
      this.report('The server reported a malformed identity key', error);
      return null;
    }
  }

  /** (Re-)reads this install's AIK; own devices are judged only once the read completed. */
  private reloadIdentity(): void {
    this.identityReadFor = this.options.session.getState().user?.identity_key ?? null;
    this.ownIdentity = null;
    const read = ++this.identityReads;
    this.identityRead = this.options.session
      .getIdentity()
      .then((identity) => {
        if (this.stopped || read !== this.identityReads) return;
        this.ownIdentity = identity?.publicKey ?? null;
        this.directory.invalidate(this.userId);
      })
      .catch((error: unknown) => this.report('Could not read the identity key', error));
  }

  /**
   * Stores the AIK from a `link` transfer. Written through SecureItems rather than
   * SessionManager.adoptIdentity: the receive queue also runs inside the logout hook, where waiting
   * for a SessionManager operation would deadlock. The checks adoptIdentity makes (account key,
   * matching pair) were done by the transfer receiver.
   */
  private async storeIdentity(identity: IdentityKeyPair): Promise<void> {
    if (this.stopped || this.options.session.getActiveDevice()?.deviceId !== this.deviceId) {
      throw new Error('The session ended during the link transfer');
    }
    await this.options.session.items.setIdentity(this.userId, identity);
    this.identityReads++; // a read that started earlier must not bring back the replaced item
    this.ownIdentity = identity.publicKey;
    this.directory.invalidate(this.userId);
  }

  private refreshLinkState(): void {
    if (this.stopped) return;
    // Not awaited: it queues behind other SessionManager operations (e.g. a running logout).
    this.options.session.refreshLinkState().catch((error: unknown) => {
      if (!isSignedOutError(error)) this.report('Could not refresh the link state', error);
    });
  }

  private report(message: string, error: unknown): void {
    if (!this.stopped) this.options.logger.warn(message, error);
  }
}
