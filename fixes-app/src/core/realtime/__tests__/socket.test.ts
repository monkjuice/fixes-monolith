import { FakeWebSocketFactory } from '../../../test-utils/fakeWebSocket';
import { MemorySecureStore } from '../../../test-utils/memorySecureStore';
import { apiError, createStubFetch } from '../../../test-utils/stubFetch';
import { createApiStack } from '../../api';
import { ApiError, NetworkError } from '../../api/errors';
import { uuidv4 } from '../../crypto/random';
import { SecureItems, SessionRefreshTokenStore } from '../../session/secureItems';
import { BACKOFF_MAX_MS, BACKOFF_MIN_MS, backoffDelay } from '../backoff';
import { RealtimeSocket, type RealtimeEvents, type SocketTokenSource } from '../socket';

const URL = 'wss://api.fixes.test/v1/ws';

function envelope() {
  return {
    id: '6734a1b2c3d4e5f6a7b8c9d0',
    sender_user_id: uuidv4(),
    sender_device_id: uuidv4(),
    recipient_device_id: uuidv4(),
    nonce: Buffer.alloc(24).toString('base64'),
    ciphertext: Buffer.alloc(272).toString('base64'),
    created_at: '2026-11-13T10:00:00.000Z',
  };
}

class FakeTokens implements SocketTokenSource {
  token = 'token-1';
  refreshCalls: (string | null)[] = [];
  refreshResult: () => Promise<string> = async () => {
    this.token = `token-${this.refreshCalls.length + 1}`;
    return this.token;
  };

  async getAccessToken(): Promise<string> {
    return this.token;
  }

  refresh(stale: string | null): Promise<string> {
    this.refreshCalls.push(stale);
    return this.refreshResult();
  }
}

function setup(options: { random?: () => number } = {}) {
  const factory = new FakeWebSocketFactory();
  const tokens = new FakeTokens();
  const socket = new RealtimeSocket({ url: URL, factory, tokens, random: options.random ?? (() => 0.5) });
  const events: { type: keyof RealtimeEvents; payload: unknown }[] = [];
  for (const type of ['ready', 'envelope', 'devices_changed', 'protocolError', 'status'] as const) {
    socket.events.on(type, (payload) => events.push({ type, payload }));
  }
  return { factory, tokens, socket, events };
}

/** Lets pending promise continuations run without advancing the clock. */
const flush = () => jest.advanceTimersByTimeAsync(0);

async function connectReady(ctx: ReturnType<typeof setup>, gap = false) {
  ctx.socket.start();
  await flush();
  ctx.factory.last.serverOpen();
  ctx.factory.last.serverSend({ type: 'ready', gap });
}

describe('RealtimeSocket (§6)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('connects without a token in the URL and sends the auth frame first', async () => {
    const ctx = setup();
    ctx.socket.start();
    await flush();
    expect(ctx.factory.sockets).toHaveLength(1);
    expect(ctx.factory.last.url).toBe(URL);
    ctx.factory.last.serverOpen();
    expect(ctx.factory.last.sentFrames()).toEqual([{ type: 'auth', token: 'token-1' }]);
    expect(ctx.socket.status).toBe('authenticating');
  });

  it('reports ready with the gap flag, then envelopes and devices_changed', async () => {
    const ctx = setup();
    await connectReady(ctx, true);
    expect(ctx.socket.status).toBe('ready');
    const env = envelope();
    ctx.factory.last.serverSend({ type: 'envelope', envelope: env });
    ctx.factory.last.serverSend({ type: 'devices_changed' });
    ctx.factory.last.serverSend({ type: 'something_new' });
    const relevant = ctx.events.filter((e) => e.type !== 'status');
    expect(relevant).toEqual([
      { type: 'ready', payload: { gap: true } },
      { type: 'envelope', payload: { envelope: env } },
      { type: 'devices_changed', payload: undefined },
    ]);
  });

  it('reports malformed frames without dropping the connection', async () => {
    const ctx = setup();
    await connectReady(ctx);
    ctx.factory.last.serverSend('not json');
    ctx.factory.last.serverSend({ type: 'envelope', envelope: { ...envelope(), sender_user_id: 'x' } });
    expect(ctx.events.filter((e) => e.type === 'protocolError')).toHaveLength(2);
    expect(ctx.events.some((e) => e.type === 'envelope')).toBe(false);
    expect(ctx.socket.status).toBe('ready');
  });

  it('pings every 25 s and acks over the socket', async () => {
    const ctx = setup();
    await connectReady(ctx);
    const ws = ctx.factory.last;
    expect(ctx.socket.sendAck(['a', 'b'])).toBe(true);
    await jest.advanceTimersByTimeAsync(25_000);
    ws.serverSend({ type: 'pong' });
    await jest.advanceTimersByTimeAsync(25_000);
    expect(ws.sentFrames()).toEqual([
      { type: 'auth', token: 'token-1' },
      { type: 'ack', ids: ['a', 'b'] },
      { type: 'ping' },
      { type: 'ping' },
    ]);
  });

  it('cannot ack before ready', async () => {
    const ctx = setup();
    ctx.socket.start();
    await flush();
    ctx.factory.last.serverOpen();
    expect(ctx.socket.sendAck(['a'])).toBe(false);
  });

  it('drops a connection that stopped answering and reconnects', async () => {
    const ctx = setup();
    await connectReady(ctx);
    await jest.advanceTimersByTimeAsync(75_000); // three ping periods without any frame
    expect(ctx.factory.sockets[0].closedByClient).not.toBeNull();
    await jest.advanceTimersByTimeAsync(BACKOFF_MAX_MS);
    expect(ctx.factory.sockets).toHaveLength(2);
  });

  it('4401: refreshes once with the server (no cached token) and reconnects immediately', async () => {
    const ctx = setup();
    ctx.socket.start();
    await flush();
    ctx.factory.last.serverOpen();
    ctx.factory.last.serverClose(4401);
    await flush();
    expect(ctx.tokens.refreshCalls).toEqual([null]);
    expect(ctx.factory.sockets).toHaveLength(2);
    ctx.factory.last.serverOpen();
    // The reconnect authenticates with the refreshed token.
    expect(ctx.factory.last.sentFrames()).toEqual([{ type: 'auth', token: 'token-2' }]);
  });

  it('4401 twice in a row: no second refresh, falls back to backoff', async () => {
    const ctx = setup();
    ctx.socket.start();
    await flush();
    ctx.factory.last.serverOpen();
    ctx.factory.last.serverClose(4401);
    await flush();
    ctx.factory.last.serverOpen();
    ctx.factory.last.serverClose(4401);
    await flush();
    expect(ctx.tokens.refreshCalls).toHaveLength(1);
    expect(ctx.socket.status).toBe('backoff');
    expect(ctx.factory.sockets).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(BACKOFF_MIN_MS);
    expect(ctx.factory.sockets).toHaveLength(3);
  });

  it.each(['device_revoked', 'invalid_refresh_token'] as const)(
    '4401 with refresh failing %s stops for good',
    async (code) => {
      const ctx = setup();
      ctx.tokens.refreshResult = () => Promise.reject(new ApiError({ status: 401, code, message: code }));
      ctx.socket.start();
      await flush();
      ctx.factory.last.serverOpen();
      ctx.factory.last.serverClose(4401);
      await flush();
      expect(ctx.socket.status).toBe('stopped');
      await jest.advanceTimersByTimeAsync(5 * 60_000);
      expect(ctx.factory.sockets).toHaveLength(1);
    },
  );

  it('4401 after a REST call rotated the access token still asks the server, and stops when the device was revoked', async () => {
    const items = new SecureItems(new MemorySecureStore());
    await items.setSession({ user_id: uuidv4(), device_id: uuidv4(), refresh_token: 'refresh-0' });
    const requests: string[] = [];
    const { tokens } = createApiStack({
      apiBaseUrl: 'https://api.fixes.test',
      refreshTokens: new SessionRefreshTokenStore(items),
      fetch: createStubFetch((request) => {
        requests.push(`${request.method} ${request.path}`);
        return apiError(401, 'device_revoked');
      }),
    });
    tokens.setTokens({ access_token: 'access-1', expires_in: 900 });
    const signedOut: string[] = [];
    tokens.events.on('signedOut', ({ reason }) => signedOut.push(reason));
    const factory = new FakeWebSocketFactory();
    const socket = new RealtimeSocket({ url: URL, factory, tokens, random: () => 0.5 });
    socket.start();
    await flush();
    factory.last.serverOpen();
    expect(factory.last.sentFrames()).toEqual([{ type: 'auth', token: 'access-1' }]);
    factory.last.serverSend({ type: 'ready', gap: false });
    // The socket lives for hours; meanwhile REST calls refreshed the access token.
    tokens.setTokens({ access_token: 'access-2', expires_in: 900 });

    // The device is removed on another phone: the server closes the socket.
    factory.last.serverClose(4401, 'device_revoked');
    await flush();
    expect(requests).toEqual(['POST /v1/auth/refresh']);
    expect(signedOut).toEqual(['device_revoked']);
    expect(socket.status).toBe('stopped');
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(factory.sockets).toHaveLength(1);
  });

  it('4401 with a network failure during refresh reconnects with backoff', async () => {
    const ctx = setup();
    ctx.tokens.refreshResult = () => Promise.reject(new NetworkError('offline', 'offline'));
    ctx.socket.start();
    await flush();
    ctx.factory.last.serverOpen();
    ctx.factory.last.serverClose(4401);
    await flush();
    expect(ctx.socket.status).toBe('backoff');
    await jest.advanceTimersByTimeAsync(BACKOFF_MIN_MS);
    expect(ctx.factory.sockets).toHaveLength(2);
  });

  it('4408 (auth timeout) reconnects with backoff', async () => {
    const ctx = setup();
    ctx.socket.start();
    await flush();
    ctx.factory.last.serverOpen();
    ctx.factory.last.serverClose(4408);
    await flush();
    expect(ctx.socket.status).toBe('backoff');
    await jest.advanceTimersByTimeAsync(BACKOFF_MIN_MS - 1);
    expect(ctx.factory.sockets).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(ctx.factory.sockets).toHaveLength(2);
    expect(ctx.tokens.refreshCalls).toHaveLength(0);
  });

  it('4409 (replaced): stays down until resume()', async () => {
    const ctx = setup();
    await connectReady(ctx);
    ctx.factory.last.serverClose(4409);
    await flush();
    expect(ctx.socket.status).toBe('replaced');
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    ctx.socket.start(); // start() must not override the replacement either
    await flush();
    expect(ctx.factory.sockets).toHaveLength(1);
    ctx.socket.resume();
    await flush();
    expect(ctx.factory.sockets).toHaveLength(2);
  });

  it('other closes back off exponentially from 1 s to 30 s and reset after ready', async () => {
    const ctx = setup({ random: () => 0.5 }); // no jitter at the midpoint
    ctx.socket.start();
    await flush();
    const expected = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (const delay of expected) {
      const count = ctx.factory.sockets.length;
      ctx.factory.last.serverClose(1006);
      await flush();
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(ctx.factory.sockets).toHaveLength(count);
      await jest.advanceTimersByTimeAsync(1);
      expect(ctx.factory.sockets).toHaveLength(count + 1);
    }
    ctx.factory.last.serverOpen();
    ctx.factory.last.serverSend({ type: 'ready', gap: false });
    const count = ctx.factory.sockets.length;
    ctx.factory.last.serverClose(1006);
    await flush();
    await jest.advanceTimersByTimeAsync(1000);
    expect(ctx.factory.sockets).toHaveLength(count + 1);
  });

  it('a network failure while getting the token also backs off', async () => {
    const ctx = setup();
    ctx.tokens.getAccessToken = () => Promise.reject(new NetworkError('offline', 'offline'));
    ctx.socket.start();
    await flush();
    expect(ctx.factory.sockets).toHaveLength(0);
    expect(ctx.socket.status).toBe('backoff');
  });

  it('stop() closes the socket and never reconnects', async () => {
    const ctx = setup();
    await connectReady(ctx);
    const ws = ctx.factory.last;
    ctx.socket.stop();
    expect(ws.closedByClient).toEqual({ code: 1000, reason: 'client stop' });
    expect(ctx.socket.status).toBe('stopped');
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(ctx.factory.sockets).toHaveLength(1);
    expect(ws.sentFrames().filter((f) => f.type === 'ping')).toHaveLength(0);
  });
});

describe('backoffDelay', () => {
  it('stays within 1 s..30 s with ±25 % jitter', () => {
    expect(backoffDelay(0, () => 0)).toBe(1000);
    expect(backoffDelay(0, () => 0.999)).toBeLessThanOrEqual(1250);
    expect(backoffDelay(3, () => 0)).toBe(6000);
    expect(backoffDelay(3, () => 0.999)).toBeLessThanOrEqual(10000);
    expect(backoffDelay(20, () => 0)).toBe(22500);
    expect(backoffDelay(20, () => 0.999)).toBe(30000);
  });
});
