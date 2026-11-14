import type { User } from '../api/types';
import { isUuidV4, randomFloat, uuidv4 } from '../crypto/random';
import type { ContactIdentityRow, MessageRow } from '../db/types';
import type { Unsubscribe } from '../events';
import { IDLE_INCOMING_TRANSFER, type IncomingTransferState } from '../linking/incoming';
import { IDLE_OUTGOING_LINK, type OutgoingLinkState } from '../linking/outgoing';
import { consoleLogger, type Logger } from '../logger';
import { isValidMessageBody } from '../payloads/message';
import { systemClock, type Clock, type WebSocketFactory } from '../platform';
import type { SocketStatus } from '../realtime/socket';
import type { SessionState } from '../session/sessionManager';
import { StateCell } from '../utils/stateCell';
import { ensureConversation } from './conversationSummary';
import { MailboxNotDrainedError, MessagingError, OutboxNotEmptyError } from './errors';
import { queueReceipt } from './receiptQueue';
import { MessagingRuntime, type MessagingSession, type RuntimeMode } from './runtime';
import { DEFAULT_MESSAGING_TIMINGS, type MessagingTimings } from './timings';

export interface MessagingState {
  /** 'stopped' without a session; 'linking' while waiting to be linked; 'ready' otherwise. */
  status: 'stopped' | RuntimeMode;
  connection: SocketStatus;
  /** A mailbox drain is running. */
  syncing: boolean;
  /** §13: the server reported a gap (dropped envelopes); show the "missed some messages" banner. */
  gap: boolean;
}

const STOPPED: MessagingState = { status: 'stopped', connection: 'idle', syncing: false, gap: false };

export interface MessagingEngineOptions {
  session: MessagingSession;
  socketFactory: WebSocketFactory;
  clock?: Clock;
  /** Uniform [0, 1) for backoff jitter; crypto-backed by default. */
  random?: () => number;
  logger?: Logger;
  timings?: Partial<MessagingTimings>;
}

/**
 * `unsent`: items stayed in the outbox after the flush; `undrained`: messaging was not running, so the
 * mailbox could not be drained first. Either way `logout({ force: true })` logs out anyway.
 */
export type LogoutOutcome = { status: 'loggedOut' } | { status: 'unsent'; remaining: number } | { status: 'undrained' };

/**
 * The messaging engine (protocol §7–§9, §13): follows the session (a runtime per signed-in device),
 * and is the API the UI calls. Observable with `getState`/`subscribe` (useSyncExternalStore), the two
 * sides of linking with `incomingLink` / `outgoingLink`, and data through the LocalStore's change
 * topics.
 */
export class MessagingEngine {
  readonly state = new StateCell<MessagingState>(STOPPED);
  /** New-device side of linking (QR shown here). */
  readonly incomingLink = new StateCell<IncomingTransferState>(IDLE_INCOMING_TRANSFER);
  /** Linked-device side (this device scanned a QR). */
  readonly outgoingLink = new StateCell<OutgoingLinkState>(IDLE_OUTGOING_LINK);
  readonly getState = this.state.get;
  readonly subscribe = this.state.subscribe;
  private runtime: MessagingRuntime | null = null;
  private runtimeSubscriptions: Unsubscribe[] = [];
  private attached: Unsubscribe[] = [];
  private forceLogout = false;
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly logger: Logger;
  private readonly timings: MessagingTimings;

  constructor(private readonly options: MessagingEngineOptions) {
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? randomFloat;
    this.logger = options.logger ?? consoleLogger;
    this.timings = { ...DEFAULT_MESSAGING_TIMINGS, ...options.timings };
  }

  /** Follows the session from now on and registers the §13 logout step. */
  attach(): Unsubscribe {
    if (this.attached.length === 0) {
      const { session } = this.options;
      this.attached.push(
        session.subscribe((state) => this.sync(state)),
        session.addLogoutHook(() => this.beforeLogout()),
      );
      this.sync(session.getState());
    }
    return () => this.detach();
  }

  detach(): void {
    for (const unsubscribe of this.attached.splice(0)) unsubscribe();
    this.stopRuntime();
  }

  // ---- messaging API ----------------------------------------------------------------------------

  /**
   * §13 Send: stores the message as pending together with its outbox row, then wakes the worker.
   * `profile` (from the friends list) names a conversation that does not exist yet.
   */
  async sendMessage(peerUserId: string, body: string, options: { profile?: User } = {}): Promise<MessageRow> {
    const rt = this.requireRuntime('ready');
    if (!isUuidV4(peerUserId) || peerUserId === rt.userId) throw new MessagingError('invalid_peer');
    if (!isValidMessageBody(body)) throw new MessagingError('invalid_body');
    const pin = await rt.store.contactIdentities.get(peerUserId);
    if (pin?.pending_identity_key) throw new MessagingError('identity_pending');
    const now = this.clock.now();
    const row: MessageRow = {
      id: uuidv4(),
      peer_user_id: peerUserId,
      direction: 'out',
      sender_user_id: rt.userId,
      body,
      sent_at: now,
      server_ts: null,
      sort_ts: now,
      received_at: null,
      status: 'pending',
    };
    const profile = options.profile?.id === peerUserId ? options.profile : null;
    const placeholder = await rt.store.transaction(async (tx) => {
      let created = false;
      if (profile) {
        await tx.conversations.insertIfMissing({
          peerUserId,
          peerUsername: profile.username,
          peerAvatarUrl: profile.avatar_url,
          lastActivityAt: now,
        });
      } else {
        created = await ensureConversation(tx, peerUserId, now);
      }
      await tx.messages.insertOrIgnore(row);
      await tx.conversations.bumpActivity(peerUserId, now);
      await tx.outbox.enqueueMessage(row.id, now);
      return created;
    });
    if (placeholder) rt.profiles.fetchInBackground([peerUserId]);
    rt.outbox.kick({ retryNow: true });
    return row;
  }

  /** Tap on a failed message: back to pending and into the outbox. */
  async retryMessage(messageId: string): Promise<boolean> {
    const rt = this.requireRuntime('ready');
    const message = await rt.store.messages.get(messageId);
    if (!message || message.direction !== 'out') throw new MessagingError('not_found');
    const pin = await rt.store.contactIdentities.get(message.peer_user_id);
    if (pin?.pending_identity_key) throw new MessagingError('identity_pending');
    const now = this.clock.now();
    const retried = await rt.store.transaction(async (tx) => {
      if (!(await tx.messages.retryFailed(messageId))) return false;
      await tx.outbox.enqueueMessage(messageId, now);
      return true;
    });
    if (retried) rt.outbox.kick({ retryNow: true });
    return retried;
  }

  /**
   * The user viewed the conversation on this device: `received → read`, unread count cleared and a
   * read receipt queued for exactly the rows that changed here (§7.2). Returns how many changed.
   */
  async markConversationRead(peerUserId: string): Promise<number> {
    const rt = this.requireRuntime();
    const now = this.clock.now();
    const ids = await rt.store.transaction(async (tx) => {
      const changed = await tx.messages.markIncomingRead(peerUserId);
      await tx.conversations.recountUnread(peerUserId);
      if (changed.length > 0) {
        await queueReceipt(tx, {
          peer: peerUserId,
          status: 'read',
          ids: changed,
          now,
          debounceMs: this.timings.receiptDebounceMs,
        });
      }
      return changed;
    });
    if (ids.length > 0) rt.outbox.kick();
    return ids.length;
  }

  /** §8: Accept on the safety-code banner. Pins the new key (unverified) and unblocks sending. */
  async acceptIdentityChange(peerUserId: string): Promise<boolean> {
    const rt = this.requireRuntime();
    const accepted = await rt.directory.acceptIdentityChange(peerUserId);
    if (accepted) rt.outbox.kick({ retryNow: true });
    return accepted;
  }

  /** §8: "Mark as verified" after comparing safety codes. */
  async setContactVerified(peerUserId: string, verified: boolean): Promise<void> {
    await this.requireRuntime().store.contactIdentities.setVerified(peerUserId, verified);
  }

  getContactIdentity(peerUserId: string): Promise<ContactIdentityRow | null> {
    return this.requireRuntime().store.contactIdentities.get(peerUserId);
  }

  /** Creates (or renames) the conversation for a friend picked in "New conversation". */
  async ensureConversation(user: User): Promise<void> {
    const rt = this.requireRuntime();
    if (!isUuidV4(user.id) || user.id === rt.userId) throw new MessagingError('invalid_peer');
    const now = this.clock.now();
    await rt.store.transaction(async (tx) => {
      const inserted = await tx.conversations.insertIfMissing({
        peerUserId: user.id,
        peerUsername: user.username,
        peerAvatarUrl: user.avatar_url,
        lastActivityAt: now,
      });
      if (!inserted) await tx.conversations.updateProfile(user.id, user.username, user.avatar_url, now);
    });
  }

  /** §13 inbox refresh: `GET /v1/users?ids=` at most once a minute (unless forced). */
  refreshPeers(options: { force?: boolean } = {}): Promise<boolean> {
    return this.requireRuntime().profiles.refreshAll(options);
  }

  /** Drains the mailbox now (pull to refresh). */
  syncNow(): Promise<void> {
    return this.requireRuntime().receiver.drain();
  }

  /** The app returned to the foreground. */
  onForeground(): void {
    this.runtime?.onForeground();
  }

  dismissGap(): void {
    this.state.update({ gap: false });
  }

  /**
   * §13 logout: drains the mailbox and flushes the outbox first. When items remain, or the mailbox
   * cannot be drained because messaging is not running, the logout stops and reports it, unless
   * `force` (the user confirmed the warning).
   */
  async logout(options: { force?: boolean } = {}): Promise<LogoutOutcome> {
    this.forceLogout = options.force === true;
    try {
      await this.options.session.logout();
      return { status: 'loggedOut' };
    } catch (error) {
      if (error instanceof OutboxNotEmptyError) return { status: 'unsent', remaining: error.remaining };
      if (error instanceof MailboxNotDrainedError) return { status: 'undrained' };
      throw error;
    } finally {
      this.forceLogout = false;
    }
  }

  // ---- linking API --------------------------------------------------------------------------------

  /** New device: the QR to show on "Link this device" (§9 step 2). */
  createLinkQr(): Promise<string> {
    return this.requireRuntime().incoming.createQr();
  }

  cancelIncomingLink(): Promise<void> {
    return this.requireRuntime().incoming.cancel();
  }

  /** Linked device: link the device whose QR was scanned (§9 steps 3–4). Outcome in `outgoingLink`. */
  startLink(qrText: string): Promise<void> {
    return this.requireRuntime('ready').outgoing.start(qrText);
  }

  resendLink(): Promise<void> {
    return this.requireRuntime('ready').outgoing.resend();
  }

  cancelLink(): void {
    this.runtime?.outgoing.cancel();
  }

  resetLink(): void {
    this.runtime?.outgoing.reset();
  }

  // ---- internals ----------------------------------------------------------------------------------

  private sync(state: SessionState): void {
    const active = this.options.session.getActiveDevice();
    const mode: RuntimeMode | null =
      active && state.status === 'ready' ? 'ready' : active && state.status === 'needsLink' ? 'linking' : null;
    if (!mode || !active) {
      this.stopRuntime();
      return;
    }
    const current = this.runtime;
    if (current && current.userId === active.userId && current.deviceId === active.deviceId) {
      current.setMode(mode);
      this.state.update({ status: mode });
      return;
    }
    this.stopRuntime();
    let store;
    try {
      store = this.options.session.getLocalStore();
    } catch (error) {
      this.logger.error('The session is active but its database is not open', error);
      return;
    }
    const runtime: MessagingRuntime = new MessagingRuntime(
      {
        session: this.options.session,
        socketFactory: this.options.socketFactory,
        clock: this.clock,
        random: this.random,
        logger: this.logger,
        timings: this.timings,
        onConnection: (connection) => {
          if (this.runtime === runtime) this.state.update({ connection });
        },
        onSyncing: (syncing) => {
          if (this.runtime === runtime) this.state.update({ syncing });
        },
        onGap: () => {
          if (this.runtime === runtime) this.state.update({ gap: true });
        },
      },
      active,
      store,
      mode,
    );
    this.runtime = runtime;
    this.runtimeSubscriptions.push(
      runtime.incoming.state.subscribe((s) => this.incomingLink.set(s)),
      runtime.outgoing.state.subscribe((s) => this.outgoingLink.set(s)),
    );
    this.state.set({ ...STOPPED, status: mode });
    runtime.start();
  }

  private stopRuntime(): void {
    const runtime = this.runtime;
    if (!runtime) return;
    this.runtime = null;
    for (const unsubscribe of this.runtimeSubscriptions.splice(0)) unsubscribe();
    runtime.stop();
    this.state.set(STOPPED);
    this.incomingLink.set(IDLE_INCOMING_TRANSFER);
    this.outgoingLink.set(IDLE_OUTGOING_LINK);
  }

  /** The §13 logout step, run by SessionManager.logout before the server logout. */
  private async beforeLogout(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) {
      // Messaging is not running (the session is loading or failed to load, e.g. the startup error
      // screen): the mailbox cannot be drained, and revoking the device deletes what waits in it (§5.4).
      if (!this.forceLogout) throw new MailboxNotDrainedError();
      this.logger.warn('Logging out without draining the mailbox; envelopes still waiting for this device are lost');
      return;
    }
    await runtime.receiver.drain();
    const remaining = runtime.outbox.running ? await runtime.outbox.flush() : await runtime.store.outbox.count();
    if (remaining === 0) return;
    if (!this.forceLogout) throw new OutboxNotEmptyError(remaining);
    this.logger.warn(`Logging out with ${remaining} unsent outbox item(s); they stay in the local database`);
  }

  private requireRuntime(mode?: RuntimeMode): MessagingRuntime {
    const runtime = this.runtime;
    if (!runtime || (mode !== undefined && runtime.mode !== mode)) throw new MessagingError('not_ready');
    return runtime;
  }
}
