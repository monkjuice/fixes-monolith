import { MemorySecureStore } from '../../../test-utils/memorySecureStore';
import { apiError, createStubFetch, json, routes, type StubHandler, type StubRequest } from '../../../test-utils/stubFetch';
import { uuidv4 } from '../../crypto/random';
import type { FetchLike, HttpUpload, HttpUploadRequest } from '../../platform';
import { SecureItems, SecureKeys, SessionRefreshTokenStore } from '../../session/secureItems';
import { ApiError, createApiStack, NetworkError, parseRetryAfter, staleDevicesDetails } from '../index';

const BASE = 'https://api.fixes.test';
const userId = uuidv4();
const deviceId = uuidv4();

const user = (id = uuidv4(), username = 'alice') => ({ id, username, avatar_url: null });
const tokens = (n: number) => ({
  access_token: `access-${n}`,
  refresh_token: `refresh-${n}`,
  token_type: 'bearer',
  expires_in: 900,
});

async function setup(handler: StubHandler, options: { upload?: HttpUpload } = {}) {
  const store = new MemorySecureStore();
  const items = new SecureItems(store);
  await items.setSession({ user_id: userId, device_id: deviceId, refresh_token: 'refresh-0' });
  store.log.length = 0;
  const fetch = createStubFetch(handler);
  const stack = createApiStack({
    apiBaseUrl: BASE,
    refreshTokens: new SessionRefreshTokenStore(items),
    fetch,
    upload: options.upload ?? null,
  });
  stack.tokens.setTokens({ access_token: 'access-0', expires_in: 900 });
  const signedOut: string[] = [];
  stack.tokens.events.on('signedOut', ({ reason }) => signedOut.push(reason));
  return { ...stack, fetch, store, items, signedOut };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject');
}

describe('ApiClient error mapping', () => {
  it('maps the §5.1 error body to ApiError', async () => {
    const { api } = await setup(() => apiError(409, 'username_taken', 'That name is taken'));
    const error = (await caught(api.register('alice_1', 'password123'))) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(409);
    expect(error.code).toBe('username_taken');
    expect(error.message).toBe('That name is taken');
  });

  it('keeps details (validation_error fields, stale_devices lists)', async () => {
    const stale = uuidv4();
    const { api } = await setup(() =>
      apiError(409, 'stale_devices', 'stale', { stale_device_ids: [stale], missing_device_ids: [] }),
    );
    const error = (await caught(api.postEnvelopes([]))) as ApiError;
    expect(error.code).toBe('stale_devices');
    expect(staleDevicesDetails(error.details)).toEqual({ stale_device_ids: [stale], missing_device_ids: [] });
  });

  it('reads Retry-After on 429', async () => {
    const { api } = await setup(() => ({
      status: 429,
      body: { error: { code: 'rate_limited', message: 'slow down', details: {} } },
      headers: { 'Retry-After': '17' },
    }));
    const error = (await caught(api.searchUsers('bob'))) as ApiError;
    expect(error.code).toBe('rate_limited');
    expect(error.retryAfter).toBe(17);
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:10 GMT', Date.parse('Wed, 21 Oct 2015 07:28:00 GMT'))).toBe(10);
    expect(parseRetryAfter('garbage')).toBeNull();
  });

  it('maps bodies that are not the error shape to unknown_error and unknown codes too', async () => {
    const { api } = await setup((req) =>
      req.path.startsWith('/v1/friends') ? { status: 502, body: '<html>Bad gateway</html>' } : apiError(400, 'brand_new_code'),
    );
    const gateway = (await caught(api.listFriends())) as ApiError;
    expect(gateway.status).toBe(502);
    expect(gateway.code).toBe('unknown_error');
    const unknown = (await caught(api.getUser(uuidv4()))) as ApiError;
    expect(unknown.code).toBe('unknown_error');
  });

  it('turns transport failures into NetworkError', async () => {
    const { api } = await setup(() => {
      throw new TypeError('Network request failed');
    });
    const error = await caught(api.listFriends());
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).kind).toBe('offline');
  });

  describe('when the response body stalls after the headers (a link that died silently)', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    /** Headers arrive at once, the body never ends; with `honoursAbort` its read fails on abort (expo/fetch). */
    function stalledBodyStack(honoursAbort: boolean) {
      const signals: AbortSignal[] = [];
      const fetch: FetchLike = async (_url, init) => {
        const signal = init.signal!;
        signals.push(signal);
        return {
          status: 200,
          headers: { get: () => null },
          text: () =>
            new Promise<string>((_resolve, reject) => {
              if (honoursAbort) signal.addEventListener('abort', () => reject(new Error('Request aborted')));
            }),
        };
      };
      const stack = createApiStack({
        apiBaseUrl: BASE,
        refreshTokens: new SessionRefreshTokenStore(new SecureItems(new MemorySecureStore())),
        fetch,
      });
      stack.tokens.setTokens({ access_token: 'access-0', expires_in: 900 });
      return { ...stack, signals };
    }

    function track(promise: Promise<unknown>): { settled: unknown } {
      const result: { settled: unknown } = { settled: null };
      promise.then(
        (value) => (result.settled = { value }),
        (error: unknown) => (result.settled = { error }),
      );
      return result;
    }

    it.each([true, false])('times the request out, body included (read fails on abort: %s)', async (honoursAbort) => {
      jest.useFakeTimers();
      const { api, signals } = stalledBodyStack(honoursAbort);
      const result = track(api.listFriends());
      await jest.advanceTimersByTimeAsync(29_999);
      expect(result.settled).toBeNull();
      await jest.advanceTimersByTimeAsync(1);
      const { error } = result.settled as { error: NetworkError };
      expect(error).toBeInstanceOf(NetworkError);
      expect(error.kind).toBe('timeout');
      expect(signals[0].aborted).toBe(true);
    });

    it('gives a page of envelopes (up to about 4 MiB) 120 s, body included', async () => {
      jest.useFakeTimers();
      const { api, signals } = stalledBodyStack(true);
      const result = track(api.getEnvelopes(100));
      await jest.advanceTimersByTimeAsync(119_999);
      expect(result.settled).toBeNull();
      await jest.advanceTimersByTimeAsync(1);
      expect(result.settled).toMatchObject({ error: { kind: 'timeout' } });
      expect(signals[0].aborted).toBe(true);
    });
  });

  it('rejects 2xx responses that break the contract', async () => {
    const { api } = await setup(() => json(200, { users: [{ id: 'not-a-uuid', username: 'x', avatar_url: null }] }));
    const error = (await caught(api.searchUsers('x'))) as ApiError;
    expect(error.code).toBe('invalid_response');
    const { api: api2 } = await setup(() => ({ status: 200, body: '{not json' }));
    expect(((await caught(api2.getMe())) as ApiError).code).toBe('invalid_response');
  });
});

describe('ApiClient authentication', () => {
  it('sends the bearer token on authenticated calls only', async () => {
    const { api, fetch } = await setup(
      routes({
        'GET /v1/users/me': () => json(200, { ...user(userId), identity_key: null }),
        'POST /v1/auth/register': () => json(201, { user: user() }),
      }),
    );
    await api.getMe();
    await api.register('alice_1', 'password123');
    expect(fetch.calls[0].headers.Authorization).toBe('Bearer access-0');
    expect(fetch.calls[1].headers.Authorization).toBeUndefined();
  });

  it('refreshes once for concurrent 401s and retries every call with the new token', async () => {
    let refreshCalls = 0;
    const { api, fetch } = await setup(async (req) => {
      if (req.path === '/v1/auth/refresh') {
        refreshCalls++;
        expect(req.body).toEqual({ refresh_token: 'refresh-0' });
        // Let the other callers pile up on the in-flight refresh.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return json(200, tokens(1));
      }
      if (req.headers.Authorization !== 'Bearer access-1') return apiError(401, 'unauthorized');
      return json(200, { friends: [] });
    });
    const results = await Promise.all([api.listFriends(), api.listFriends(), api.listFriends(), api.listFriends()]);
    expect(results).toEqual(Array(4).fill({ friends: [] }));
    expect(refreshCalls).toBe(1);
    const retried = fetch.calls.filter((c) => c.path === '/v1/friends' && c.headers.Authorization === 'Bearer access-1');
    expect(retried).toHaveLength(4);
  });

  it('does not refresh again for a 401 that raced a refresh already completed', async () => {
    let refreshCalls = 0;
    const { api, tokens: tm } = await setup(async (req) => {
      if (req.path === '/v1/auth/refresh') {
        refreshCalls++;
        return json(200, tokens(refreshCalls));
      }
      return req.headers.Authorization === 'Bearer access-1' ? json(200, { friends: [] }) : apiError(401, 'unauthorized');
    });
    await tm.refresh('access-0');
    // A caller that still holds the old token gets the current one without a second refresh.
    await expect(tm.refresh('access-0')).resolves.toBe('access-1');
    await api.listFriends();
    expect(refreshCalls).toBe(1);
  });

  it('persists the rotated refresh token before using the new access token', async () => {
    const timeline: string[] = [];
    const store = new MemorySecureStore();
    const originalSet = store.setItem.bind(store);
    store.setItem = async (key, value) => {
      if (key === SecureKeys.session) timeline.push(`persist ${JSON.parse(value).refresh_token}`);
      return originalSet(key, value);
    };
    const items = new SecureItems(store);
    await items.setSession({ user_id: userId, device_id: deviceId, refresh_token: 'refresh-0' });
    timeline.length = 0;
    const fetch = createStubFetch((req: StubRequest) => {
      timeline.push(`${req.method} ${req.path} ${req.headers.Authorization ?? ''}`.trim());
      if (req.path === '/v1/auth/refresh') return json(200, tokens(1));
      return req.headers.Authorization === 'Bearer access-1' ? json(204) : apiError(401, 'unauthorized');
    });
    const { api, tokens: tm } = createApiStack({ apiBaseUrl: BASE, refreshTokens: new SessionRefreshTokenStore(items), fetch });
    tm.setTokens({ access_token: 'access-0', expires_in: 900 });
    await api.ackEnvelopes(['1']);
    expect(timeline).toEqual([
      'POST /v1/envelopes/ack Bearer access-0',
      'POST /v1/auth/refresh',
      'persist refresh-1',
      'POST /v1/envelopes/ack Bearer access-1',
    ]);
    expect((await items.getSession())?.refresh_token).toBe('refresh-1');
  });

  it('does not use the new tokens when persisting the refresh token fails', async () => {
    const { api, store, fetch } = await setup((req) => {
      if (req.path === '/v1/auth/refresh') return json(200, tokens(1));
      return apiError(401, 'unauthorized');
    });
    store.failWrites = true;
    await expect(api.listFriends()).rejects.toThrow(/Simulated secure storage failure/);
    expect(fetch.calls.filter((c) => c.headers.Authorization === 'Bearer access-1')).toHaveLength(0);
  });

  it('refreshes proactively when the access token is about to expire', async () => {
    const { api, tokens: tm, fetch } = await setup((req) => {
      if (req.path === '/v1/auth/refresh') return json(200, tokens(1));
      return json(200, { friends: [] });
    });
    tm.setTokens({ access_token: 'access-0', expires_in: 10 }); // inside the 30 s margin
    await api.listFriends();
    expect(fetch.calls.map((c) => c.path)).toEqual(['/v1/auth/refresh', '/v1/friends']);
  });

  it('gives up after one retry when the new token is also rejected', async () => {
    let refreshCalls = 0;
    const { api, signedOut } = await setup((req) => {
      if (req.path === '/v1/auth/refresh') {
        refreshCalls++;
        return json(200, tokens(refreshCalls));
      }
      return apiError(401, 'unauthorized');
    });
    const error = (await caught(api.listFriends())) as ApiError;
    expect(error.code).toBe('unauthorized');
    expect(refreshCalls).toBe(1);
    expect(signedOut).toEqual([]);
  });

  it.each(['device_revoked', 'invalid_refresh_token'])('emits signedOut when refresh answers %s', async (code) => {
    const { api, signedOut, tokens: tm } = await setup((req) =>
      req.path === '/v1/auth/refresh' ? apiError(401, code) : apiError(401, 'unauthorized'),
    );
    const error = (await caught(api.listFriends())) as ApiError;
    expect(error.code).toBe(code);
    expect(signedOut).toEqual([code]);
    expect(tm.currentAccessToken()).toBeNull();
  });

  it('emits signedOut when any endpoint answers device_revoked', async () => {
    const { api, signedOut } = await setup(() => apiError(401, 'device_revoked'));
    await caught(api.getEnvelopes());
    expect(signedOut).toEqual(['device_revoked']);
  });

  it('does not sign out when the refresh fails for network reasons', async () => {
    const { api, signedOut } = await setup((req) => {
      if (req.path === '/v1/auth/refresh') throw new TypeError('offline');
      return apiError(401, 'unauthorized');
    });
    expect(await caught(api.listFriends())).toBeInstanceOf(NetworkError);
    expect(signedOut).toEqual([]);
  });

  it('a refresh that completes after clear() does not resurrect the session', async () => {
    let release: () => void = () => undefined;
    const { tokens: tm, items } = await setup(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return json(200, tokens(1));
    });
    const pending = tm.refresh(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    tm.clear();
    release();
    await expect(pending).rejects.toBeInstanceOf(ApiError);
    expect(tm.currentAccessToken()).toBeNull();
    expect((await items.getSession())?.refresh_token).toBe('refresh-0');
  });
});

describe('ApiClient endpoints (§5.3)', () => {
  const peer = uuidv4();
  const dev = uuidv4();
  const req = uuidv4();
  const me = { ...user(userId), identity_key: null };
  const myDevice = {
    id: deviceId,
    name: 'Pixel',
    public_key: Buffer.alloc(32, 1).toString('base64'),
    certificate: null,
    created_at: '2026-11-13T10:00:00.000Z',
    last_seen_at: '2026-11-13T10:00:00.000Z',
    current: true,
  };
  const friendRequest = { id: req, from_user: user(userId), to_user: user(peer, 'bob'), created_at: '2026-11-13T10:00:00.000Z' };
  const envelope = {
    id: '6734a1b2c3d4e5f6a7b8c9d0',
    sender_user_id: peer,
    sender_device_id: dev,
    recipient_device_id: deviceId,
    nonce: Buffer.alloc(24).toString('base64'),
    ciphertext: Buffer.alloc(272).toString('base64'),
    created_at: '2026-11-13T10:00:00.000Z',
  };

  const cases: {
    name: string;
    call: (api: Awaited<ReturnType<typeof setup>>['api']) => Promise<unknown>;
    method: string;
    path: string;
    body?: unknown;
    reply: { status: number; body?: unknown };
    auth: boolean;
  }[] = [
    { name: 'health', call: (a) => a.health(), method: 'GET', path: '/healthz', reply: json(200, { status: 'ok' }), auth: false },
    {
      name: 'register',
      call: (a) => a.register('alice_1', 'password123'),
      method: 'POST',
      path: '/v1/auth/register',
      body: { username: 'alice_1', password: 'password123' },
      reply: json(201, { user: user() }),
      auth: false,
    },
    {
      name: 'login',
      call: (a) => a.login('alice_1', 'password123', { name: 'Pixel', public_key: myDevice.public_key }),
      method: 'POST',
      path: '/v1/auth/login',
      body: { username: 'alice_1', password: 'password123', device: { name: 'Pixel', public_key: myDevice.public_key } },
      reply: json(200, { ...tokens(1), user: me, device: myDevice }),
      auth: false,
    },
    { name: 'logout', call: (a) => a.logout(), method: 'POST', path: '/v1/auth/logout', reply: json(204), auth: true },
    {
      name: 'changePassword',
      call: (a) => a.changePassword('old-password', 'new-password'),
      method: 'POST',
      path: '/v1/auth/password',
      body: { current_password: 'old-password', new_password: 'new-password' },
      reply: json(204),
      auth: true,
    },
    {
      name: 'resetIdentity',
      call: (a) => a.resetIdentity('password123', 'KEY=', 'CERT='),
      method: 'POST',
      path: '/v1/auth/reset-identity',
      body: { password: 'password123', identity_key: 'KEY=', device_certificate: 'CERT=' },
      reply: json(200, { user: me }),
      auth: true,
    },
    {
      name: 'putIdentity',
      call: (a) => a.putIdentity('KEY=', 'CERT='),
      method: 'PUT',
      path: '/v1/users/me/identity',
      body: { identity_key: 'KEY=', device_certificate: 'CERT=' },
      reply: json(200, { user: me }),
      auth: true,
    },
    {
      name: 'putDeviceCertificate',
      call: (a) => a.putDeviceCertificate(dev, 'CERT='),
      method: 'PUT',
      path: `/v1/devices/${dev}/certificate`,
      body: { certificate: 'CERT=' },
      reply: json(200, myDevice),
      auth: true,
    },
    { name: 'listMyDevices', call: (a) => a.listMyDevices(), method: 'GET', path: '/v1/devices', reply: json(200, { devices: [myDevice] }), auth: true },
    { name: 'revokeDevice', call: (a) => a.revokeDevice(dev), method: 'DELETE', path: `/v1/devices/${dev}`, reply: json(204), auth: true },
    {
      name: 'getUserDevices',
      call: (a) => a.getUserDevices(peer),
      method: 'GET',
      path: `/v1/users/${peer}/devices`,
      reply: json(200, { identity_key: null, devices: [{ id: dev, public_key: myDevice.public_key, certificate: Buffer.alloc(64, 2).toString('base64') }] }),
      auth: true,
    },
    {
      name: 'getUserDevice',
      call: (a) => a.getUserDevice(peer, dev),
      method: 'GET',
      path: `/v1/users/${peer}/devices/${dev}`,
      reply: json(200, { id: dev, user_id: peer, public_key: myDevice.public_key, certificate: null, revoked_at: null }),
      auth: true,
    },
    { name: 'getMe', call: (a) => a.getMe(), method: 'GET', path: '/v1/users/me', reply: json(200, me), auth: true },
    { name: 'searchUsers', call: (a) => a.searchUsers('bo_b'), method: 'GET', path: '/v1/users?q=bo_b', reply: json(200, { users: [] }), auth: true },
    {
      name: 'getUsersByIds',
      call: (a) => a.getUsersByIds([peer, dev]),
      method: 'GET',
      path: `/v1/users?ids=${encodeURIComponent(`${peer},${dev}`)}`,
      reply: json(200, { users: [user(peer, 'bob')] }),
      auth: true,
    },
    { name: 'getUser', call: (a) => a.getUser(peer), method: 'GET', path: `/v1/users/${peer}`, reply: json(200, user(peer)), auth: true },
    { name: 'listFriends', call: (a) => a.listFriends(), method: 'GET', path: '/v1/friends', reply: json(200, { friends: [] }), auth: true },
    { name: 'removeFriend', call: (a) => a.removeFriend(peer), method: 'DELETE', path: `/v1/friends/${peer}`, reply: json(204), auth: true },
    {
      name: 'listFriendRequests',
      call: (a) => a.listFriendRequests(),
      method: 'GET',
      path: '/v1/friend-requests',
      reply: json(200, { incoming: [friendRequest], outgoing: [] }),
      auth: true,
    },
    {
      name: 'createFriendRequest',
      call: (a) => a.createFriendRequest(peer),
      method: 'POST',
      path: '/v1/friend-requests',
      body: { to_user_id: peer },
      reply: json(201, { status: 'pending', friend_request: friendRequest }),
      auth: true,
    },
    {
      name: 'acceptFriendRequest',
      call: (a) => a.acceptFriendRequest(req),
      method: 'POST',
      path: `/v1/friend-requests/${req}/accept`,
      reply: json(200, { friend: user(peer, 'bob') }),
      auth: true,
    },
    {
      name: 'deleteFriendRequest',
      call: (a) => a.deleteFriendRequest(req),
      method: 'DELETE',
      path: `/v1/friend-requests/${req}`,
      reply: json(204),
      auth: true,
    },
    {
      name: 'postEnvelopes',
      call: (a) => a.postEnvelopes([{ recipient_device_id: dev, nonce: 'N', ciphertext: 'C' }], [peer, userId]),
      method: 'POST',
      path: '/v1/envelopes',
      body: { envelopes: [{ recipient_device_id: dev, nonce: 'N', ciphertext: 'C' }], complete_for_user_ids: [peer, userId] },
      reply: json(201, { ids: ['6734a1b2c3d4e5f6a7b8c9d0', null], created_at: '2026-11-13T10:00:00.000Z', dropped_device_ids: [dev] }),
      auth: true,
    },
    {
      name: 'getEnvelopes',
      call: (a) => a.getEnvelopes(250),
      method: 'GET',
      path: '/v1/envelopes?limit=250',
      reply: json(200, { envelopes: [envelope], gap: true }),
      auth: true,
    },
    {
      name: 'ackEnvelopes',
      call: (a) => a.ackEnvelopes(['6734a1b2c3d4e5f6a7b8c9d0']),
      method: 'POST',
      path: '/v1/envelopes/ack',
      body: { ids: ['6734a1b2c3d4e5f6a7b8c9d0'] },
      reply: json(204),
      auth: true,
    },
  ];

  it.each(cases)('$name → $method $path', async ({ call, method, path, body, reply, auth }) => {
    const { api, fetch } = await setup(() => reply);
    const result = await call(api);
    expect(fetch.calls).toHaveLength(1);
    const [request] = fetch.calls;
    expect(request.method).toBe(method);
    expect(request.path).toBe(path);
    expect(request.url).toBe(BASE + path);
    expect(request.body).toEqual(body);
    expect(request.headers.Authorization).toBe(auth ? 'Bearer access-0' : undefined);
    if (reply.status === 204) expect(result).toBeUndefined();
    else expect(result).toEqual(reply.body);
  });

  it('rejects an empty or oversized ids lookup locally', async () => {
    const { api, fetch } = await setup(() => json(200, { users: [] }));
    await expect(api.getUsersByIds([])).rejects.toThrow(RangeError);
    await expect(api.getUsersByIds(Array(101).fill(peer))).rejects.toThrow(RangeError);
    expect(fetch.calls).toHaveLength(0);
  });

  it('uploads the avatar as multipart field "image" with the bearer token, retrying after refresh', async () => {
    const sent: HttpUploadRequest[] = [];
    const upload: HttpUpload = {
      async send(request) {
        sent.push(request);
        const ok = request.headers.Authorization === 'Bearer access-1';
        const body = ok ? { user: { ...user(userId), identity_key: null } } : { error: { code: 'unauthorized', message: 'x', details: {} } };
        return { status: ok ? 200 : 401, headers: { get: () => null }, text: async () => JSON.stringify(body) };
      },
    };
    const { api } = await setup((r) => (r.path === '/v1/auth/refresh' ? json(200, tokens(1)) : apiError(404, 'not_found')), {
      upload,
    });
    const result = await api.uploadAvatar('file:///cache/avatar.jpg');
    expect(result.user.id).toBe(userId);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      url: `${BASE}/v1/users/me/avatar`,
      method: 'PUT',
      field: 'image',
      file: { uri: 'file:///cache/avatar.jpg', name: 'avatar.jpg', type: 'image/jpeg' },
    });
  });
});
