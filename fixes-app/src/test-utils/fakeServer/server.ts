import { fromBase64Exact, toBase64 } from '../../core/crypto/encoding';
import { verifyDeviceCertificate } from '../../core/crypto/identity';
import { randomBytes, uuidv4 } from '../../core/crypto/random';
import type { WebSocketFactory } from '../../core/platform';
import type { StubRequest, StubResponse } from '../stubFetch';
import {
  FakeDevice,
  pairKey,
  wireEnvelope,
  type EnvelopePost,
  type FakeEnvelope,
  type FakeFriendRequest,
  type FakeUser,
} from './model';
import { createSocketFactory, type FakeServerSocket, type RealtimeHost } from './realtime';
import { handleRest } from './rest';

/**
 * In-memory stand-in for fixes-server (protocol §5–§6) for unit tests and UI tests: auth, identity,
 * devices, users, friends, envelopes (all §5.3 checks, mailbox caps, gap) and the WebSocket (auth,
 * ready, live envelope push, devices_changed, ack, 4401/4409). Certificates are verified like the real
 * server. Not implemented: avatar upload, rate limits, request size limits.
 *
 * Use `createStubFetch(server.handle)` as the session's fetch and `server.socketFactory` as the
 * engine's WebSocketFactory. Test-only helpers (no protocol equivalent) are marked "admin".
 */
export class FakeFixesServer implements RealtimeHost {
  readonly users = new Map<string, FakeUser>();
  readonly devices = new Map<string, FakeDevice>();
  readonly friendships = new Set<string>();
  readonly friendRequests = new Map<string, FakeFriendRequest>();
  /** Pending envelopes in id order. */
  envelopes: FakeEnvelope[] = [];
  /** Every accepted POST /v1/envelopes, for counting traffic. */
  readonly posts: EnvelopePost[] = [];
  /** "METHOD /path" of every REST request. */
  readonly requests: string[] = [];
  /** Every socket the factory created (also closed ones). */
  readonly sockets: FakeServerSocket[] = [];
  readonly socketFactory: WebSocketFactory;
  /** Set to make every request and new socket fail like an unreachable server. */
  offline = false;
  /** Admin: answer a request before routing (return undefined to route normally). */
  interceptor: ((request: StubRequest) => StubResponse | undefined) | null = null;
  /** Admin: rewrites a routed response (e.g. what a compromised server would list). */
  responseFilter: ((request: StubRequest, response: StubResponse) => StubResponse) | null = null;
  /** Every REST answer: status, error code and the calling device (null when unauthenticated). */
  readonly log: { method: string; path: string; status: number; code: string | null; deviceId: string | null }[] = [];
  /** Admin: envelopes matching this stay invisible (not listed, not pushed) until released. */
  holdFilter: ((envelope: FakeEnvelope) => boolean) | null = null;
  readonly mailboxCaps = { perDevice: 5000, perSender: 1000 };
  readonly accessTokens = new Map<string, string>();
  readonly refreshTokens = new Map<string, string>();
  /** Envelopes withheld by `holdFilter`, in arrival order. */
  readonly held: FakeEnvelope[] = [];
  private readonly connected = new Map<string, FakeServerSocket>();
  private clockOffsetMs = 0;
  private envelopeCounter = 0;

  constructor() {
    this.socketFactory = createSocketFactory(this, this.sockets);
  }

  // ---- time ---------------------------------------------------------------------------------

  now(): number {
    return Date.now() + this.clockOffsetMs;
  }

  nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  /** Admin: moves the server clock (envelope created_at, revoked_at). */
  advanceClock(ms: number): void {
    this.clockOffsetMs += ms;
  }

  // ---- admin helpers ------------------------------------------------------------------------

  addUser(username: string, password: string, identityKey: string | null = null): FakeUser {
    const user: FakeUser = { id: uuidv4(), username, password, identityKey, avatarUrl: null };
    this.users.set(user.id, user);
    return user;
  }

  findUser(username: string): FakeUser | undefined {
    return [...this.users.values()].find((u) => u.username.toLowerCase() === username.toLowerCase());
  }

  devicesOf(userId: string): FakeDevice[] {
    return [...this.devices.values()].filter((d) => d.userId === userId);
  }

  activeDevicesOf(userId: string): FakeDevice[] {
    return this.devicesOf(userId).filter((d) => !d.revoked);
  }

  /** Admin: a device created without a login (e.g. one a malicious server invented). */
  addDevice(userId: string, options: { publicKey: string; certificate?: string | null; name?: string }): FakeDevice {
    const device = new FakeDevice(uuidv4(), userId, options.name ?? 'Injected', options.publicKey, this.nowIso());
    device.certificate = options.certificate ?? null;
    this.devices.set(device.id, device);
    return device;
  }

  makeFriends(a: string, b: string): void {
    this.friendships.add(pairKey(a, b));
  }

  unfriend(a: string, b: string): void {
    this.friendships.delete(pairKey(a, b));
  }

  areFriends(a: string, b: string): boolean {
    return this.friendships.has(pairKey(a, b));
  }

  /** Invalidates every access token, as if they all expired. */
  expireAccessTokens(): void {
    this.accessTokens.clear();
  }

  pendingFor(deviceId: string): FakeEnvelope[] {
    return this.envelopes.filter((e) => e.recipientDeviceId === deviceId);
  }

  /** Admin: stores an envelope without any check, as a compromised server could. */
  injectEnvelope(envelope: Omit<FakeEnvelope, 'id' | 'createdAt' | 'recipientUserId'> & { createdAt?: string }): FakeEnvelope {
    const recipient = this.devices.get(envelope.recipientDeviceId);
    if (!recipient) throw new Error('Unknown recipient device');
    const stored: FakeEnvelope = {
      ...envelope,
      id: this.nextEnvelopeId(),
      recipientUserId: recipient.userId,
      createdAt: envelope.createdAt ?? this.nowIso(),
    };
    this.store([stored]);
    return stored;
  }

  /** Admin: makes held envelopes visible and pushes them. */
  releaseHeld(): void {
    const released = this.held.splice(0);
    this.holdFilter = null;
    this.envelopes = [...this.envelopes, ...released].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const envelope of released) this.push(envelope);
  }

  /** Admin: forgets held envelopes, as if the server lost them. */
  discardHeld(): void {
    this.held.splice(0);
    this.holdFilter = null;
  }

  /** Admin: the device a request's bearer token belongs to (for interceptors). */
  deviceOfRequest(request: StubRequest): FakeDevice | undefined {
    const token = (request.headers.Authorization ?? '').replace(/^Bearer /, '');
    const deviceId = this.accessTokens.get(token);
    return deviceId ? this.devices.get(deviceId) : undefined;
  }

  socketOf(deviceId: string): FakeServerSocket | undefined {
    return this.connected.get(deviceId);
  }

  /** Admin: closes a device's socket with the given code (e.g. to test reconnects). */
  dropSocket(deviceId: string, code = 1006): void {
    this.connected.get(deviceId)?.closeFromServer(code, 'dropped');
  }

  // ---- REST entry point -----------------------------------------------------------------------

  readonly handle = (request: StubRequest): StubResponse => {
    if (this.offline) throw new TypeError('Network request failed');
    const path = request.path.split('?')[0];
    this.requests.push(`${request.method} ${path}`);
    const deviceId = this.deviceOfRequest(request)?.id ?? null;
    const response =
      this.interceptor?.(request) ?? this.responseFilter?.(request, handleRest(this, request)) ?? handleRest(this, request);
    const error = (response.body as { error?: { code?: string } } | undefined)?.error;
    this.log.push({ method: request.method, path, status: response.status, code: error?.code ?? null, deviceId });
    return response;
  };

  // ---- shared operations used by the REST routes ------------------------------------------------

  issueTokens(deviceId: string) {
    const access = toBase64(randomBytes(18));
    const refresh = toBase64(randomBytes(18));
    this.accessTokens.set(access, deviceId);
    this.refreshTokens.set(refresh, deviceId);
    return { access_token: access, refresh_token: refresh, token_type: 'bearer', expires_in: 900 };
  }

  certificateValid(identityKey: string, userId: string, device: FakeDevice, certificate: unknown): boolean {
    if (typeof certificate !== 'string') return false;
    return verifyDeviceCertificate({
      identityPublicKey: fromBase64Exact(identityKey, 32),
      userId,
      deviceId: device.id,
      devicePublicKey: fromBase64Exact(device.publicKey, 32),
      certificate,
    });
  }

  /** §5.4 revocation order: revoked_at, refresh tokens, pending envelopes, socket 4401, devices_changed. */
  revoke(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (!device) return;
    if (!device.revokedAt) device.revokedAt = this.nowIso();
    for (const [token, id] of this.refreshTokens) if (id === deviceId) this.refreshTokens.delete(token);
    this.envelopes = this.envelopes.filter((e) => e.recipientDeviceId !== deviceId);
    this.connected.get(deviceId)?.closeFromServer(4401, 'revoked');
    this.devicesChanged(device.userId, deviceId);
  }

  /** Sends `devices_changed` to the user's connected sockets (optionally except one device). */
  devicesChanged(userId: string, exceptDeviceId?: string): void {
    for (const device of this.activeDevicesOf(userId)) {
      if (device.id === exceptDeviceId) continue;
      this.connected.get(device.id)?.serverSend({ type: 'devices_changed' });
    }
  }

  nextEnvelopeId(): string {
    this.envelopeCounter++;
    // ObjectId-shaped (24 hex chars) and increasing, like the real server's ids.
    return this.envelopeCounter.toString(16).padStart(24, '0');
  }

  /** Stores accepted envelopes (in batch order) and pushes them to connected recipients. */
  store(envelopes: FakeEnvelope[]): void {
    for (const envelope of envelopes) {
      if (this.holdFilter?.(envelope)) {
        this.held.push(envelope);
        continue;
      }
      this.envelopes.push(envelope);
      this.push(envelope);
    }
  }

  /** One-time gap report of §5.3. */
  takeGap(device: FakeDevice): boolean {
    if (device.overflowAt === null) return false;
    device.overflowAt = null;
    return true;
  }

  ack(deviceId: string, ids: readonly string[]): void {
    const wanted = new Set(ids);
    this.envelopes = this.envelopes.filter((e) => !(e.recipientDeviceId === deviceId && wanted.has(e.id)));
  }

  // ---- RealtimeHost ---------------------------------------------------------------------------

  onSocketOpen(): void {
    // Nothing until the auth frame arrives (§6 step 1).
  }

  onSocketFrame(socket: FakeServerSocket, data: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data) as Record<string, unknown>;
    } catch {
      socket.closeFromServer(1003, 'invalid frame');
      return;
    }
    if (socket.deviceId === null) {
      if (frame.type !== 'auth' || typeof frame.token !== 'string') {
        socket.closeFromServer(4401, 'auth required');
        return;
      }
      const deviceId = this.accessTokens.get(frame.token);
      const device = deviceId ? this.devices.get(deviceId) : undefined;
      if (!device || device.revoked) {
        socket.closeFromServer(4401, 'bad token');
        return;
      }
      // §6 step 5: one socket per device; the newer one wins.
      this.connected.get(device.id)?.closeFromServer(4409, 'replaced');
      socket.deviceId = device.id;
      this.connected.set(device.id, socket);
      device.lastSeenAt = this.nowIso();
      socket.serverSend({ type: 'ready', gap: this.takeGap(device) });
      return;
    }
    if (frame.type === 'ping') socket.serverSend({ type: 'pong' });
    else if (frame.type === 'ack' && Array.isArray(frame.ids)) {
      this.ack(socket.deviceId, frame.ids.filter((id): id is string => typeof id === 'string'));
    }
  }

  onSocketClosed(socket: FakeServerSocket): void {
    if (socket.deviceId && this.connected.get(socket.deviceId) === socket) this.connected.delete(socket.deviceId);
  }

  private push(envelope: FakeEnvelope): void {
    this.connected.get(envelope.recipientDeviceId)?.serverSend({ type: 'envelope', envelope: wireEnvelope(envelope) });
  }
}
