import { fromBase64 } from '../../core/crypto/encoding';
import { isUuidV4, uuidv4 } from '../../core/crypto/random';
import { apiError, json, type StubRequest, type StubResponse } from '../stubFetch';
import { FakeDevice, pairKey, wireEnvelope, type FakeEnvelope, type FakeUser } from './model';
import type { FakeFixesServer } from './server';

/** REST routes of protocol §5.3 for FakeFixesServer. */

type Body = Record<string, unknown>;

interface Ctx {
  server: FakeFixesServer;
  request: StubRequest;
  body: Body;
  query: URLSearchParams;
  params: string[];
}

interface AuthedCtx extends Ctx {
  device: FakeDevice;
  user: FakeUser;
}

type Handler<C> = (ctx: C) => StubResponse;

interface Route {
  method: string;
  pattern: RegExp;
  auth: boolean;
  handler: Handler<AuthedCtx> | Handler<Ctx>;
}

const USERNAME = /^[A-Za-z0-9_]{3,30}$/;
const SEARCH = /^[A-Za-z0-9_]{1,30}$/;
const ENVELOPE_ID = /^[0-9a-f]{24}$/;

const validation = (field: string, message = 'invalid') =>
  apiError(422, 'validation_error', 'Validation failed', { fields: { [field]: message } });

function decodedLength(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  try {
    return fromBase64(value).length;
  } catch {
    // Not base64: the route answers with a validation error.
    return null;
  }
}

function publicUser(user: FakeUser) {
  return { id: user.id, username: user.username, avatar_url: user.avatarUrl };
}

function me(user: FakeUser) {
  return { ...publicUser(user), identity_key: user.identityKey };
}

function myDevice(device: FakeDevice, currentId: string) {
  return {
    id: device.id,
    name: device.name,
    public_key: device.publicKey,
    certificate: device.certificate,
    created_at: device.createdAt,
    last_seen_at: device.lastSeenAt,
    current: device.id === currentId,
  };
}

function friendRequest(server: FakeFixesServer, id: string) {
  const request = server.friendRequests.get(id)!;
  return {
    id: request.id,
    from_user: publicUser(server.users.get(request.fromUserId)!),
    to_user: publicUser(server.users.get(request.toUserId)!),
    created_at: request.createdAt,
  };
}

/** Self and friends only: 404 unknown user, then 403 not_friends. */
function directoryAccess(ctx: AuthedCtx, userId: string): FakeUser | StubResponse {
  const target = ctx.server.users.get(userId);
  if (!target) return apiError(404, 'not_found');
  if (userId !== ctx.user.id && !ctx.server.areFriends(ctx.user.id, userId)) return apiError(403, 'not_friends');
  return target;
}

// ---- auth ---------------------------------------------------------------------------------------

const register: Handler<Ctx> = ({ server, body }) => {
  const username = body.username;
  const password = body.password;
  if (typeof username !== 'string' || !USERNAME.test(username)) return validation('username');
  if (typeof password !== 'string' || [...password].length < 8 || [...password].length > 128) {
    return validation('password');
  }
  if (server.findUser(username)) return apiError(409, 'username_taken');
  return json(201, { user: publicUser(server.addUser(username, password)) });
};

const login: Handler<Ctx> = ({ server, body }) => {
  const user = server.findUser(String(body.username));
  if (!user || user.password !== body.password) return apiError(401, 'invalid_credentials');
  const device = body.device as { name?: unknown; public_key?: unknown } | undefined;
  if (!device || typeof device.name !== 'string' || device.name.length < 1 || device.name.length > 64) {
    return validation('device.name');
  }
  if (decodedLength(device.public_key) !== 32) return apiError(400, 'invalid_public_key');
  const publicKey = device.public_key as string;
  if ([...server.devices.values()].some((d) => d.publicKey === publicKey)) return apiError(409, 'device_key_in_use');
  const active = server.activeDevicesOf(user.id);
  if (active.length >= 10) {
    return apiError(409, 'too_many_devices', 'Too many devices', {
      devices: active.map((d) => ({ id: d.id, name: d.name, last_seen_at: d.lastSeenAt })),
    });
  }
  const created = new FakeDevice(uuidv4(), user.id, device.name, publicKey, server.nowIso());
  server.devices.set(created.id, created);
  server.devicesChanged(user.id, created.id);
  return json(200, { ...server.issueTokens(created.id), user: me(user), device: myDevice(created, created.id) });
};

const refresh: Handler<Ctx> = ({ server, body }) => {
  const token = String(body.refresh_token);
  const deviceId = server.refreshTokens.get(token);
  if (!deviceId) return apiError(401, 'invalid_refresh_token');
  server.refreshTokens.delete(token);
  const device = server.devices.get(deviceId);
  if (!device || device.revoked) return apiError(401, 'device_revoked');
  device.lastSeenAt = server.nowIso();
  return json(200, server.issueTokens(deviceId));
};

const logout: Handler<AuthedCtx> = ({ server, device }) => {
  server.revoke(device.id);
  return json(204);
};

const changePassword: Handler<AuthedCtx> = ({ server, body, user, device }) => {
  if (body.current_password !== user.password) return apiError(401, 'invalid_credentials');
  if (typeof body.new_password !== 'string' || body.new_password.length < 8) return validation('new_password');
  user.password = body.new_password;
  for (const other of server.activeDevicesOf(user.id)) if (other.id !== device.id) server.revoke(other.id);
  return json(204);
};

const resetIdentity: Handler<AuthedCtx> = ({ server, body, user, device }) => {
  if (body.password !== user.password) return apiError(401, 'invalid_credentials');
  if (decodedLength(body.identity_key) !== 32) return apiError(400, 'invalid_public_key');
  const key = body.identity_key as string;
  if (!server.certificateValid(key, user.id, device, body.device_certificate)) return apiError(400, 'invalid_certificate');
  for (const other of server.activeDevicesOf(user.id)) if (other.id !== device.id) server.revoke(other.id);
  user.identityKey = key;
  device.certificate = body.device_certificate as string;
  server.devicesChanged(user.id);
  return json(200, { user: me(user) });
};

// ---- identity & devices ---------------------------------------------------------------------------

const putIdentity: Handler<AuthedCtx> = ({ server, body, user, device }) => {
  if (user.identityKey !== null) return apiError(409, 'identity_exists');
  if (decodedLength(body.identity_key) !== 32) return apiError(400, 'invalid_public_key');
  const key = body.identity_key as string;
  if (!server.certificateValid(key, user.id, device, body.device_certificate)) return apiError(400, 'invalid_certificate');
  user.identityKey = key;
  device.certificate = body.device_certificate as string;
  server.devicesChanged(user.id);
  return json(200, { user: me(user) });
};

const putCertificate: Handler<AuthedCtx> = ({ server, body, user, device, params }) => {
  const target = server.devices.get(params[0]);
  if (!target || target.userId !== user.id || target.revoked) return apiError(404, 'not_found');
  if (!user.identityKey || !server.certificateValid(user.identityKey, user.id, target, body.certificate)) {
    return apiError(400, 'invalid_certificate');
  }
  target.certificate = body.certificate as string;
  server.devicesChanged(user.id);
  return json(200, myDevice(target, device.id));
};

const listDevices: Handler<AuthedCtx> = ({ server, user, device }) =>
  json(200, { devices: server.activeDevicesOf(user.id).map((d) => myDevice(d, device.id)) });

const deleteDevice: Handler<AuthedCtx> = ({ server, user, params }) => {
  const target = server.devices.get(params[0]);
  if (!target || target.userId !== user.id || target.revoked) return apiError(404, 'not_found');
  server.revoke(target.id);
  return json(204);
};

const userDevices: Handler<AuthedCtx> = (ctx) => {
  const target = directoryAccess(ctx, ctx.params[0]);
  if (!('id' in target)) return target;
  const devices = ctx.server
    .activeDevicesOf(target.id)
    .filter((d) => d.certificate !== null)
    .map((d) => ({ id: d.id, public_key: d.publicKey, certificate: d.certificate }));
  return json(200, { identity_key: target.identityKey, devices });
};

const userDevice: Handler<AuthedCtx> = (ctx) => {
  const target = directoryAccess(ctx, ctx.params[0]);
  if (!('id' in target)) return target;
  const device = ctx.server.devices.get(ctx.params[1]);
  if (!device || device.userId !== target.id) return apiError(404, 'not_found');
  return json(200, {
    id: device.id,
    user_id: device.userId,
    public_key: device.publicKey,
    certificate: device.certificate,
    revoked_at: device.revokedAt,
  });
};

// ---- users ------------------------------------------------------------------------------------------

const getMe: Handler<AuthedCtx> = ({ user }) => json(200, me(user));

const searchUsers: Handler<AuthedCtx> = ({ server, query, user }) => {
  const q = query.get('q');
  const ids = query.get('ids');
  if ((q === null) === (ids === null)) return validation('q', 'exactly one of q and ids');
  if (q !== null) {
    if (!SEARCH.test(q)) return validation('q');
    const needle = q.toLowerCase();
    const users = [...server.users.values()]
      .filter((u) => u.id !== user.id && u.username.toLowerCase().includes(needle))
      .sort((a, b) => a.username.localeCompare(b.username))
      .slice(0, 20)
      .map(publicUser);
    return json(200, { users });
  }
  const list = ids!.split(',');
  if (list.length < 1 || list.length > 100 || !list.every(isUuidV4)) return validation('ids');
  const users = list.map((id) => server.users.get(id)).filter((u): u is FakeUser => !!u).map(publicUser);
  return json(200, { users });
};

const getUser: Handler<AuthedCtx> = ({ server, params }) => {
  const target = server.users.get(params[0]);
  return target ? json(200, publicUser(target)) : apiError(404, 'not_found');
};

// ---- friends ----------------------------------------------------------------------------------------

const listFriends: Handler<AuthedCtx> = ({ server, user }) => {
  const friends = [...server.users.values()]
    .filter((u) => u.id !== user.id && server.areFriends(user.id, u.id))
    .sort((a, b) => a.username.localeCompare(b.username))
    .map(publicUser);
  return json(200, { friends });
};

const removeFriend: Handler<AuthedCtx> = ({ server, user, params }) => {
  if (!server.areFriends(user.id, params[0])) return apiError(404, 'not_found');
  server.unfriend(user.id, params[0]);
  return json(204);
};

const listFriendRequests: Handler<AuthedCtx> = ({ server, user }) => {
  const all = [...server.friendRequests.values()];
  return json(200, {
    incoming: all.filter((r) => r.toUserId === user.id).map((r) => friendRequest(server, r.id)),
    outgoing: all.filter((r) => r.fromUserId === user.id).map((r) => friendRequest(server, r.id)),
  });
};

const createFriendRequest: Handler<AuthedCtx> = ({ server, body, user }) => {
  const toUserId = body.to_user_id;
  if (!isUuidV4(toUserId)) return validation('to_user_id');
  const target = server.users.get(toUserId);
  if (!target) return apiError(404, 'not_found');
  if (target.id === user.id) return apiError(400, 'cannot_friend_self');
  if (server.areFriends(user.id, target.id)) return apiError(409, 'already_friends');
  const existing = [...server.friendRequests.values()].find((r) => pairKey(r.fromUserId, r.toUserId) === pairKey(user.id, target.id));
  if (existing && existing.fromUserId === target.id) {
    server.makeFriends(user.id, target.id);
    server.friendRequests.delete(existing.id);
    return json(200, { status: 'accepted', friend: publicUser(target) });
  }
  if (existing) return apiError(409, 'request_exists');
  const id = uuidv4();
  server.friendRequests.set(id, { id, fromUserId: user.id, toUserId: target.id, createdAt: server.nowIso() });
  return json(201, { status: 'pending', friend_request: friendRequest(server, id) });
};

const acceptFriendRequest: Handler<AuthedCtx> = ({ server, user, params }) => {
  const request = server.friendRequests.get(params[0]);
  if (!request || request.toUserId !== user.id) return apiError(404, 'not_found');
  server.makeFriends(request.fromUserId, request.toUserId);
  server.friendRequests.delete(request.id);
  return json(200, { friend: publicUser(server.users.get(request.fromUserId)!) });
};

const deleteFriendRequest: Handler<AuthedCtx> = ({ server, user, params }) => {
  const request = server.friendRequests.get(params[0]);
  if (!request || (request.toUserId !== user.id && request.fromUserId !== user.id)) return apiError(404, 'not_found');
  server.friendRequests.delete(request.id);
  return json(204);
};

// ---- envelopes --------------------------------------------------------------------------------------

/** POST /v1/envelopes with every rule of §5.3, checked before anything is stored. */
const postEnvelopes: Handler<AuthedCtx> = ({ server, body, user, device }) => {
  const list = body.envelopes;
  if (!Array.isArray(list) || list.length < 1 || list.length > 100) return validation('envelopes');
  const completeFor = body.complete_for_user_ids ?? [];
  if (!Array.isArray(completeFor) || completeFor.length > 2 || !completeFor.every(isUuidV4)) {
    return validation('complete_for_user_ids');
  }
  const items: { recipient: string; nonce: string; ciphertext: string }[] = [];
  for (const raw of list as Body[]) {
    if (typeof raw !== 'object' || raw === null || !isUuidV4(raw.recipient_device_id)) {
      return validation('envelopes.recipient_device_id');
    }
    if (decodedLength(raw.nonce) !== 24) return validation('envelopes.nonce');
    const size = decodedLength(raw.ciphertext);
    if (size === null || size < 16) return validation('envelopes.ciphertext');
    if (size > 65536) return apiError(413, 'payload_too_large');
    items.push({ recipient: raw.recipient_device_id, nonce: raw.nonce as string, ciphertext: raw.ciphertext as string });
  }
  const targets = [...new Set(items.map((i) => i.recipient))];
  const found = targets.map((id) => server.devices.get(id)).filter((d): d is FakeDevice => !!d);
  const others = new Set(found.filter((d) => d.userId !== user.id).map((d) => d.userId));
  const completeOthers = (completeFor as string[]).filter((u) => u !== user.id);
  // 403s first, so a sender that may not write to someone never learns their device ids.
  if (![...others, ...completeOthers].every((u) => server.areFriends(user.id, u))) return apiError(403, 'not_friends');
  if (others.size > 0 && device.certificate === null) return apiError(403, 'device_not_linked');
  const stale = targets.filter((id) => {
    const d = server.devices.get(id);
    return !d || d.revoked || (d.userId !== user.id && d.certificate === null);
  });
  const missing = [...new Set(completeFor as string[])]
    .flatMap((u) => server.activeDevicesOf(u).filter((d) => d.certificate !== null))
    .filter((d) => d.id !== device.id && !targets.includes(d.id))
    .map((d) => d.id)
    .sort();
  if (stale.length > 0 || missing.length > 0) {
    return apiError(409, 'stale_devices', 'Some recipient devices are unknown, revoked, not linked or missing', {
      stale_device_ids: stale,
      missing_device_ids: missing,
    });
  }

  const createdAt = server.nowIso();
  const counts = new Map<string, { total: number; fromSender: number }>();
  for (const id of targets) {
    const pending = server.pendingFor(id);
    counts.set(id, { total: pending.length, fromSender: pending.filter((e) => e.senderUserId === user.id).length });
  }
  const ids: (string | null)[] = [];
  const dropped = new Set<string>();
  const stored: FakeEnvelope[] = [];
  for (const item of items) {
    const recipient = server.devices.get(item.recipient)!;
    const count = counts.get(item.recipient)!;
    const foreign = recipient.userId !== user.id;
    if (count.total >= server.mailboxCaps.perDevice || (foreign && count.fromSender >= server.mailboxCaps.perSender)) {
      ids.push(null);
      dropped.add(recipient.id);
      if (recipient.overflowAt === null) recipient.overflowAt = createdAt;
      continue;
    }
    count.total++;
    count.fromSender++;
    const envelope: FakeEnvelope = {
      id: server.nextEnvelopeId(),
      recipientDeviceId: recipient.id,
      recipientUserId: recipient.userId,
      senderUserId: user.id,
      senderDeviceId: device.id,
      nonce: item.nonce,
      ciphertext: item.ciphertext,
      createdAt,
    };
    stored.push(envelope);
    ids.push(envelope.id);
  }
  server.posts.push({
    senderUserId: user.id,
    senderDeviceId: device.id,
    recipientDeviceIds: stored.map((e) => e.recipientDeviceId),
    completeFor: completeFor as string[],
    createdAt,
  });
  server.store(stored);
  return json(201, { ids, created_at: createdAt, dropped_device_ids: [...dropped] });
};

const getEnvelopes: Handler<AuthedCtx> = ({ server, query, device }) => {
  const raw = query.get('limit');
  const limit = raw === null ? 100 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) return validation('limit');
  const envelopes = server.pendingFor(device.id).slice(0, limit).map(wireEnvelope);
  return json(200, { envelopes, gap: server.takeGap(device) });
};

const ackEnvelopes: Handler<AuthedCtx> = ({ server, body, device }) => {
  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 500 || !ids.every((id) => typeof id === 'string' && ENVELOPE_ID.test(id))) {
    return validation('ids');
  }
  server.ack(device.id, ids as string[]);
  return json(204);
};

const SEG = '([^/]+)';
const ROUTES: Route[] = [
  { method: 'POST', pattern: /^\/v1\/auth\/register$/, auth: false, handler: register },
  { method: 'POST', pattern: /^\/v1\/auth\/login$/, auth: false, handler: login },
  { method: 'POST', pattern: /^\/v1\/auth\/refresh$/, auth: false, handler: refresh },
  { method: 'POST', pattern: /^\/v1\/auth\/logout$/, auth: true, handler: logout },
  { method: 'POST', pattern: /^\/v1\/auth\/password$/, auth: true, handler: changePassword },
  { method: 'POST', pattern: /^\/v1\/auth\/reset-identity$/, auth: true, handler: resetIdentity },
  { method: 'PUT', pattern: /^\/v1\/users\/me\/identity$/, auth: true, handler: putIdentity },
  { method: 'PUT', pattern: new RegExp(`^/v1/devices/${SEG}/certificate$`), auth: true, handler: putCertificate },
  { method: 'GET', pattern: /^\/v1\/devices$/, auth: true, handler: listDevices },
  { method: 'DELETE', pattern: new RegExp(`^/v1/devices/${SEG}$`), auth: true, handler: deleteDevice },
  { method: 'GET', pattern: /^\/v1\/users\/me$/, auth: true, handler: getMe },
  { method: 'GET', pattern: /^\/v1\/users$/, auth: true, handler: searchUsers },
  { method: 'GET', pattern: new RegExp(`^/v1/users/${SEG}/devices$`), auth: true, handler: userDevices },
  { method: 'GET', pattern: new RegExp(`^/v1/users/${SEG}/devices/${SEG}$`), auth: true, handler: userDevice },
  { method: 'GET', pattern: new RegExp(`^/v1/users/${SEG}$`), auth: true, handler: getUser },
  { method: 'GET', pattern: /^\/v1\/friends$/, auth: true, handler: listFriends },
  { method: 'DELETE', pattern: new RegExp(`^/v1/friends/${SEG}$`), auth: true, handler: removeFriend },
  { method: 'GET', pattern: /^\/v1\/friend-requests$/, auth: true, handler: listFriendRequests },
  { method: 'POST', pattern: /^\/v1\/friend-requests$/, auth: true, handler: createFriendRequest },
  { method: 'POST', pattern: new RegExp(`^/v1/friend-requests/${SEG}/accept$`), auth: true, handler: acceptFriendRequest },
  { method: 'DELETE', pattern: new RegExp(`^/v1/friend-requests/${SEG}$`), auth: true, handler: deleteFriendRequest },
  { method: 'POST', pattern: /^\/v1\/envelopes$/, auth: true, handler: postEnvelopes },
  { method: 'GET', pattern: /^\/v1\/envelopes$/, auth: true, handler: getEnvelopes },
  { method: 'POST', pattern: /^\/v1\/envelopes\/ack$/, auth: true, handler: ackEnvelopes },
];

export function handleRest(server: FakeFixesServer, request: StubRequest): StubResponse {
  const [rawPath, rawQuery = ''] = request.path.split('?');
  const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as Body;
  const query = new URLSearchParams(rawQuery);
  for (const route of ROUTES) {
    if (route.method !== request.method) continue;
    const match = route.pattern.exec(rawPath);
    if (!match) continue;
    const params = match.slice(1).map((p) => decodeURIComponent(p));
    const ctx: Ctx = { server, request, body, query, params };
    if (!route.auth) return (route.handler as Handler<Ctx>)(ctx);
    const auth = request.headers.Authorization ?? '';
    const deviceId = server.accessTokens.get(auth.replace(/^Bearer /, ''));
    if (!deviceId) return apiError(401, 'unauthorized');
    const device = server.devices.get(deviceId)!;
    if (device.revoked) return apiError(401, 'device_revoked');
    const user = server.users.get(device.userId)!;
    return (route.handler as Handler<AuthedCtx>)({ ...ctx, device, user });
  }
  return apiError(404, 'not_found', `FakeFixesServer does not implement ${request.method} ${rawPath}`);
}
