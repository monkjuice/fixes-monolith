/** Wire shapes from protocol §5.2/§5.3. Binary values are standard base64; timestamps are ISO 8601 UTC. */

export interface User {
  id: string;
  username: string;
  /** Absolute URL or null. */
  avatar_url: string | null;
}

export interface Me extends User {
  identity_key: string | null;
}

export interface MyDevice {
  id: string;
  name: string;
  public_key: string;
  certificate: string | null;
  created_at: string;
  last_seen_at: string;
  current: boolean;
}

export interface PeerDevice {
  id: string;
  public_key: string;
  /** Always set by the server (linked devices only); null is tolerated and treated as ineligible. */
  certificate: string | null;
}

export interface DeviceInfo {
  id: string;
  user_id: string;
  public_key: string;
  certificate: string | null;
  revoked_at: string | null;
}

export interface FriendRequest {
  id: string;
  from_user: User;
  to_user: User;
  created_at: string;
}

export interface Envelope {
  id: string;
  sender_user_id: string;
  sender_device_id: string;
  recipient_device_id: string;
  nonce: string;
  ciphertext: string;
  created_at: string;
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
  token_type: 'bearer';
  expires_in: number;
}

export interface LoginResponse extends Tokens {
  user: Me;
  device: MyDevice;
}

export interface LoginDevice {
  /** 1–64 characters. */
  name: string;
  /** Base64 of the 32-byte X25519 public key. */
  public_key: string;
}

export interface UserDevicesResponse {
  identity_key: string | null;
  devices: PeerDevice[];
}

export interface FriendRequestsResponse {
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
}

export type CreateFriendRequestResponse =
  | { status: 'pending'; friend_request: FriendRequest }
  | { status: 'accepted'; friend: User };

export interface OutgoingEnvelope {
  recipient_device_id: string;
  nonce: string;
  ciphertext: string;
}

export interface PostEnvelopesResponse {
  /** Envelope id per input, or null when a mailbox cap dropped it. */
  ids: (string | null)[];
  created_at: string;
  dropped_device_ids: string[];
}

export interface GetEnvelopesResponse {
  envelopes: Envelope[];
  gap: boolean;
}

/** Details of 409 `stale_devices`. */
export interface StaleDevicesDetails {
  stale_device_ids: string[];
  missing_device_ids: string[];
}

/** Details of 409 `too_many_devices`. */
export interface TooManyDevicesDetails {
  devices: { id: string; name: string; last_seen_at: string }[];
}
