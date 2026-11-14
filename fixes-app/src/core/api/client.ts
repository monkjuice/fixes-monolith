import { ApiError } from './errors';
import { LARGE_RESPONSE_TIMEOUT_MS, type HttpTransport, type JsonRequest } from './http';
import type { TokenManager } from './tokens';
import type {
  CreateFriendRequestResponse,
  DeviceInfo,
  FriendRequestsResponse,
  GetEnvelopesResponse,
  LoginDevice,
  LoginResponse,
  Me,
  MyDevice,
  OutgoingEnvelope,
  PostEnvelopesResponse,
  User,
  UserDevicesResponse,
} from './types';
import type { UploadFile } from '../platform';
import {
  parseCreateFriendRequestResponse,
  parseDeviceInfo,
  parseFriendRequestsResponse,
  parseFriendResponse,
  parseFriendsResponse,
  parseGetEnvelopesResponse,
  parseHealth,
  parseLoginResponse,
  parseMe,
  parseMeResponse,
  parseMyDevice,
  parseMyDevicesResponse,
  parsePostEnvelopesResponse,
  parseUser,
  parseUserDevicesResponse,
  parseUserResponse,
  parseUsersResponse,
} from './validate';

const noContent = (): void => undefined;
const seg = (value: string): string => encodeURIComponent(value);

/**
 * Typed client for every endpoint of protocol §5.3. Authenticated calls get the bearer token from the
 * TokenManager; a 401 `unauthorized` triggers one shared refresh and one retry; `device_revoked`
 * anywhere signs the device out.
 */
export class ApiClient {
  constructor(
    private readonly transport: HttpTransport,
    readonly tokens: TokenManager,
  ) {}

  // ---- Health -----------------------------------------------------------------------------

  health(): Promise<{ status: string }> {
    return this.transport.requestJson({ method: 'GET', path: '/healthz' }, parseHealth);
  }

  // ---- Auth (register, login and refresh are unauthenticated) --------------------------------

  register(username: string, password: string): Promise<{ user: User }> {
    return this.transport.requestJson(
      { method: 'POST', path: '/v1/auth/register', body: { username, password } },
      parseUserResponse,
    );
  }

  login(username: string, password: string, device: LoginDevice): Promise<LoginResponse> {
    return this.transport.requestJson(
      { method: 'POST', path: '/v1/auth/login', body: { username, password, device } },
      parseLoginResponse,
    );
  }

  /** Revokes the current device on the server. */
  logout(): Promise<void> {
    return this.authed({ method: 'POST', path: '/v1/auth/logout' }, noContent);
  }

  changePassword(currentPassword: string, newPassword: string): Promise<void> {
    return this.authed(
      {
        method: 'POST',
        path: '/v1/auth/password',
        body: { current_password: currentPassword, new_password: newPassword },
      },
      noContent,
    );
  }

  resetIdentity(password: string, identityKey: string, deviceCertificate: string): Promise<{ user: Me }> {
    return this.authed(
      {
        method: 'POST',
        path: '/v1/auth/reset-identity',
        body: { password, identity_key: identityKey, device_certificate: deviceCertificate },
      },
      parseMeResponse,
    );
  }

  // ---- Identity & devices -------------------------------------------------------------------

  putIdentity(identityKey: string, deviceCertificate: string): Promise<{ user: Me }> {
    return this.authed(
      {
        method: 'PUT',
        path: '/v1/users/me/identity',
        body: { identity_key: identityKey, device_certificate: deviceCertificate },
      },
      parseMeResponse,
    );
  }

  putDeviceCertificate(deviceId: string, certificate: string): Promise<MyDevice> {
    return this.authed(
      { method: 'PUT', path: `/v1/devices/${seg(deviceId)}/certificate`, body: { certificate } },
      parseMyDevice,
    );
  }

  listMyDevices(): Promise<{ devices: MyDevice[] }> {
    return this.authed({ method: 'GET', path: '/v1/devices' }, parseMyDevicesResponse);
  }

  revokeDevice(deviceId: string): Promise<void> {
    return this.authed({ method: 'DELETE', path: `/v1/devices/${seg(deviceId)}` }, noContent);
  }

  getUserDevices(userId: string): Promise<UserDevicesResponse> {
    return this.authed({ method: 'GET', path: `/v1/users/${seg(userId)}/devices` }, parseUserDevicesResponse);
  }

  getUserDevice(userId: string, deviceId: string): Promise<DeviceInfo> {
    return this.authed(
      { method: 'GET', path: `/v1/users/${seg(userId)}/devices/${seg(deviceId)}` },
      parseDeviceInfo,
    );
  }

  // ---- Users --------------------------------------------------------------------------------

  getMe(): Promise<Me> {
    return this.authed({ method: 'GET', path: '/v1/users/me' }, (json) => parseMe(json));
  }

  /** Substring search; callers validate `q` against `[A-Za-z0-9_]{1,30}` first (§5.3, §14). */
  searchUsers(q: string): Promise<{ users: User[] }> {
    return this.authed({ method: 'GET', path: '/v1/users', query: { q } }, parseUsersResponse);
  }

  /** 1–100 ids per call; unknown ids are omitted by the server. */
  getUsersByIds(ids: readonly string[]): Promise<{ users: User[] }> {
    if (ids.length === 0 || ids.length > 100) {
      return Promise.reject(new RangeError('getUsersByIds takes 1 to 100 ids'));
    }
    return this.authed({ method: 'GET', path: '/v1/users', query: { ids: ids.join(',') } }, parseUsersResponse);
  }

  getUser(userId: string): Promise<User> {
    return this.authed({ method: 'GET', path: `/v1/users/${seg(userId)}` }, (json) => parseUser(json));
  }

  /**
   * Multipart upload (field `image`) of the already square-cropped, ≤ 1024 px JPEG (§14).
   * `fileUri` is a file:// URI on React Native, a filesystem path in Node.
   */
  uploadAvatar(fileUri: string): Promise<{ user: Me }> {
    const file: UploadFile = { uri: fileUri, name: 'avatar.jpg', type: 'image/jpeg' };
    return this.withAuthRetry((accessToken) =>
      this.transport.uploadFile(
        { method: 'PUT', path: '/v1/users/me/avatar', field: 'image', file, accessToken },
        parseMeResponse,
      ),
    );
  }

  // ---- Friends ------------------------------------------------------------------------------

  listFriends(): Promise<{ friends: User[] }> {
    return this.authed({ method: 'GET', path: '/v1/friends' }, parseFriendsResponse);
  }

  removeFriend(userId: string): Promise<void> {
    return this.authed({ method: 'DELETE', path: `/v1/friends/${seg(userId)}` }, noContent);
  }

  listFriendRequests(): Promise<FriendRequestsResponse> {
    return this.authed({ method: 'GET', path: '/v1/friend-requests' }, parseFriendRequestsResponse);
  }

  createFriendRequest(toUserId: string): Promise<CreateFriendRequestResponse> {
    return this.authed(
      { method: 'POST', path: '/v1/friend-requests', body: { to_user_id: toUserId } },
      parseCreateFriendRequestResponse,
    );
  }

  acceptFriendRequest(requestId: string): Promise<{ friend: User }> {
    return this.authed(
      { method: 'POST', path: `/v1/friend-requests/${seg(requestId)}/accept` },
      parseFriendResponse,
    );
  }

  /** Decline (recipient) or cancel (sender). */
  deleteFriendRequest(requestId: string): Promise<void> {
    return this.authed({ method: 'DELETE', path: `/v1/friend-requests/${seg(requestId)}` }, noContent);
  }

  // ---- Envelopes ----------------------------------------------------------------------------

  postEnvelopes(envelopes: OutgoingEnvelope[], completeForUserIds?: string[]): Promise<PostEnvelopesResponse> {
    const body: Record<string, unknown> = { envelopes };
    if (completeForUserIds !== undefined) body.complete_for_user_ids = completeForUserIds;
    return this.authed({ method: 'POST', path: '/v1/envelopes', body }, parsePostEnvelopesResponse);
  }

  getEnvelopes(limit?: number): Promise<GetEnvelopesResponse> {
    return this.authed(
      {
        method: 'GET',
        path: '/v1/envelopes',
        query: { limit: limit === undefined ? undefined : String(limit) },
        timeoutMs: LARGE_RESPONSE_TIMEOUT_MS,
      },
      parseGetEnvelopesResponse,
    );
  }

  ackEnvelopes(ids: string[]): Promise<void> {
    return this.authed({ method: 'POST', path: '/v1/envelopes/ack', body: { ids } }, noContent);
  }

  // ---- Plumbing -----------------------------------------------------------------------------

  private authed<T>(req: Omit<JsonRequest, 'accessToken'>, parse: (json: unknown) => T): Promise<T> {
    return this.withAuthRetry((accessToken) => this.transport.requestJson({ ...req, accessToken }, parse));
  }

  private async withAuthRetry<T>(send: (accessToken: string) => Promise<T>): Promise<T> {
    const token = await this.tokens.getAccessToken();
    try {
      return await send(token);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401 && error.code === 'unauthorized') {
        // A 401 means the request was not processed, so retrying (even a POST) cannot duplicate it.
        const fresh = await this.tokens.refresh(token);
        return this.signOutOnRevoked(() => send(fresh));
      }
      this.checkRevoked(error);
      throw error;
    }
  }

  private async signOutOnRevoked<T>(send: () => Promise<T>): Promise<T> {
    try {
      return await send();
    } catch (error) {
      this.checkRevoked(error);
      throw error;
    }
  }

  private checkRevoked(error: unknown): void {
    if (error instanceof ApiError && error.code === 'device_revoked') this.tokens.signOut('device_revoked');
  }
}
