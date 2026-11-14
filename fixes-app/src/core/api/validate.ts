import { isUuidV4 } from '../crypto/random';
import type {
  CreateFriendRequestResponse,
  DeviceInfo,
  Envelope,
  FriendRequest,
  FriendRequestsResponse,
  GetEnvelopesResponse,
  LoginResponse,
  Me,
  MyDevice,
  PeerDevice,
  PostEnvelopesResponse,
  StaleDevicesDetails,
  Tokens,
  TooManyDevicesDetails,
  User,
  UserDevicesResponse,
} from './types';

/**
 * Runtime checks for server responses. The server is not trusted blindly: ids end up in AAD strings,
 * SQL rows and file names, so every field is type-checked before the rest of the app sees it.
 */

export class ResponseShapeError extends Error {
  constructor(path: string, expected: string) {
    super(`Unexpected response: ${path} should be ${expected}`);
    this.name = 'ResponseShapeError';
  }
}

type Obj = Record<string, unknown>;

function obj(value: unknown, path: string): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ResponseShapeError(path, 'an object');
  return value as Obj;
}

function str(value: unknown, path: string, maxLength = 4096): string {
  if (typeof value !== 'string' || value.length > maxLength) throw new ResponseShapeError(path, 'a string');
  return value;
}

function nullableStr(value: unknown, path: string, maxLength = 4096): string | null {
  return value === null ? null : str(value, path, maxLength);
}

function uuid(value: unknown, path: string): string {
  if (!isUuidV4(value)) throw new ResponseShapeError(path, 'a UUIDv4');
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new ResponseShapeError(path, 'a boolean');
  return value;
}

function arr<T>(value: unknown, path: string, item: (v: unknown, p: string) => T): T[] {
  if (!Array.isArray(value)) throw new ResponseShapeError(path, 'an array');
  return value.map((v, i) => item(v, `${path}[${i}]`));
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

function iso(value: unknown, path: string): string {
  const s = str(value, path, 64);
  if (!ISO.test(s) || Number.isNaN(Date.parse(s))) throw new ResponseShapeError(path, 'an ISO 8601 timestamp');
  return s;
}

function nullableIso(value: unknown, path: string): string | null {
  return value === null ? null : iso(value, path);
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

function b64(value: unknown, path: string, maxLength = 200_000): string {
  const s = str(value, path, maxLength);
  if (s.length % 4 !== 0 || !B64.test(s)) throw new ResponseShapeError(path, 'standard base64');
  return s;
}

function nullableB64(value: unknown, path: string): string | null {
  return value === null || value === undefined ? null : b64(value, path);
}

export function parseUser(value: unknown, path = 'user'): User {
  const o = obj(value, path);
  return {
    id: uuid(o.id, `${path}.id`),
    username: str(o.username, `${path}.username`, 64),
    avatar_url: nullableStr(o.avatar_url ?? null, `${path}.avatar_url`, 2048),
  };
}

export function parseMe(value: unknown, path = 'user'): Me {
  const o = obj(value, path);
  return { ...parseUser(o, path), identity_key: nullableB64(o.identity_key, `${path}.identity_key`) };
}

export function parseMyDevice(value: unknown, path = 'device'): MyDevice {
  const o = obj(value, path);
  return {
    id: uuid(o.id, `${path}.id`),
    name: str(o.name, `${path}.name`, 256),
    public_key: b64(o.public_key, `${path}.public_key`),
    certificate: nullableB64(o.certificate, `${path}.certificate`),
    created_at: iso(o.created_at, `${path}.created_at`),
    last_seen_at: iso(o.last_seen_at, `${path}.last_seen_at`),
    current: bool(o.current, `${path}.current`),
  };
}

export function parsePeerDevice(value: unknown, path = 'device'): PeerDevice {
  const o = obj(value, path);
  return {
    id: uuid(o.id, `${path}.id`),
    public_key: b64(o.public_key, `${path}.public_key`),
    certificate: nullableB64(o.certificate, `${path}.certificate`),
  };
}

export function parseDeviceInfo(value: unknown, path = 'device'): DeviceInfo {
  const o = obj(value, path);
  return {
    id: uuid(o.id, `${path}.id`),
    user_id: uuid(o.user_id, `${path}.user_id`),
    public_key: b64(o.public_key, `${path}.public_key`),
    certificate: nullableB64(o.certificate, `${path}.certificate`),
    revoked_at: nullableIso(o.revoked_at ?? null, `${path}.revoked_at`),
  };
}

export function parseFriendRequest(value: unknown, path = 'friend_request'): FriendRequest {
  const o = obj(value, path);
  return {
    id: str(o.id, `${path}.id`, 128),
    from_user: parseUser(o.from_user, `${path}.from_user`),
    to_user: parseUser(o.to_user, `${path}.to_user`),
    created_at: iso(o.created_at, `${path}.created_at`),
  };
}

export function parseEnvelope(value: unknown, path = 'envelope'): Envelope {
  const o = obj(value, path);
  return {
    id: str(o.id, `${path}.id`, 128),
    sender_user_id: uuid(o.sender_user_id, `${path}.sender_user_id`),
    sender_device_id: uuid(o.sender_device_id, `${path}.sender_device_id`),
    recipient_device_id: uuid(o.recipient_device_id, `${path}.recipient_device_id`),
    nonce: b64(o.nonce, `${path}.nonce`, 64),
    ciphertext: b64(o.ciphertext, `${path}.ciphertext`),
    created_at: iso(o.created_at, `${path}.created_at`),
  };
}

export function parseTokens(value: unknown, path = 'tokens'): Tokens {
  const o = obj(value, path);
  const expiresIn = o.expires_in;
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new ResponseShapeError(`${path}.expires_in`, 'a positive number');
  }
  if (typeof o.token_type !== 'string' || o.token_type.toLowerCase() !== 'bearer') {
    throw new ResponseShapeError(`${path}.token_type`, '"bearer"');
  }
  return {
    access_token: str(o.access_token, `${path}.access_token`, 8192),
    refresh_token: str(o.refresh_token, `${path}.refresh_token`, 512),
    token_type: 'bearer',
    expires_in: expiresIn,
  };
}

export function parseLoginResponse(value: unknown): LoginResponse {
  const o = obj(value, 'login');
  return { ...parseTokens(o, 'login'), user: parseMe(o.user, 'login.user'), device: parseMyDevice(o.device, 'login.device') };
}

export function parseUserResponse(value: unknown): { user: User } {
  return { user: parseUser(obj(value, 'response').user) };
}

export function parseMeResponse(value: unknown): { user: Me } {
  return { user: parseMe(obj(value, 'response').user) };
}

export function parseUsersResponse(value: unknown): { users: User[] } {
  return { users: arr(obj(value, 'response').users, 'users', parseUser) };
}

export function parseFriendsResponse(value: unknown): { friends: User[] } {
  return { friends: arr(obj(value, 'response').friends, 'friends', parseUser) };
}

export function parseMyDevicesResponse(value: unknown): { devices: MyDevice[] } {
  return { devices: arr(obj(value, 'response').devices, 'devices', parseMyDevice) };
}

export function parseUserDevicesResponse(value: unknown): UserDevicesResponse {
  const o = obj(value, 'response');
  return {
    identity_key: nullableB64(o.identity_key, 'identity_key'),
    devices: arr(o.devices, 'devices', parsePeerDevice),
  };
}

export function parseFriendRequestsResponse(value: unknown): FriendRequestsResponse {
  const o = obj(value, 'response');
  return {
    incoming: arr(o.incoming, 'incoming', parseFriendRequest),
    outgoing: arr(o.outgoing, 'outgoing', parseFriendRequest),
  };
}

export function parseCreateFriendRequestResponse(value: unknown): CreateFriendRequestResponse {
  const o = obj(value, 'response');
  if (o.status === 'pending') return { status: 'pending', friend_request: parseFriendRequest(o.friend_request) };
  if (o.status === 'accepted') return { status: 'accepted', friend: parseUser(o.friend, 'friend') };
  throw new ResponseShapeError('status', '"pending" or "accepted"');
}

export function parseFriendResponse(value: unknown): { friend: User } {
  return { friend: parseUser(obj(value, 'response').friend, 'friend') };
}

export function parsePostEnvelopesResponse(value: unknown): PostEnvelopesResponse {
  const o = obj(value, 'response');
  return {
    ids: arr(o.ids, 'ids', (v, p) => (v === null ? null : str(v, p, 128))),
    created_at: iso(o.created_at, 'created_at'),
    dropped_device_ids: arr(o.dropped_device_ids ?? [], 'dropped_device_ids', uuid),
  };
}

export function parseGetEnvelopesResponse(value: unknown): GetEnvelopesResponse {
  const o = obj(value, 'response');
  return { envelopes: arr(o.envelopes, 'envelopes', parseEnvelope), gap: bool(o.gap, 'gap') };
}

export function parseHealth(value: unknown): { status: string } {
  return { status: str(obj(value, 'response').status, 'status', 64) };
}

/** Typed view of 409 stale_devices details; missing lists become empty. */
export function staleDevicesDetails(details: Record<string, unknown>): StaleDevicesDetails {
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter(isUuidV4) : []);
  return { stale_device_ids: ids(details.stale_device_ids), missing_device_ids: ids(details.missing_device_ids) };
}

/** Typed view of 409 too_many_devices details; malformed entries are dropped. */
export function tooManyDevicesDetails(details: Record<string, unknown>): TooManyDevicesDetails {
  const list = Array.isArray(details.devices) ? details.devices : [];
  const devices: TooManyDevicesDetails['devices'] = [];
  for (const d of list) {
    if (typeof d === 'object' && d !== null) {
      const r = d as Obj;
      if (isUuidV4(r.id) && typeof r.name === 'string' && typeof r.last_seen_at === 'string') {
        devices.push({ id: r.id, name: r.name, last_seen_at: r.last_seen_at });
      }
    }
  }
  return { devices };
}
