import type { FriendRequestsResponse, User } from '../../core/api/types';

/** Where I stand with another user, which decides the profile buttons (§14). */
export type Friendship =
  | { kind: 'self' }
  | { kind: 'friends' }
  | { kind: 'requestSent'; requestId: string }
  | { kind: 'requestReceived'; requestId: string }
  | { kind: 'none' };

/**
 * Derived from `GET /v1/friends` and `GET /v1/friend-requests`. Friendship wins over a leftover
 * request (the server deletes the request after creating the friendship, §5.3 write order).
 */
export function friendshipWith(
  me: string,
  userId: string,
  friends: readonly User[],
  requests: FriendRequestsResponse,
): Friendship {
  if (userId === me) return { kind: 'self' };
  if (friends.some((friend) => friend.id === userId)) return { kind: 'friends' };
  const received = requests.incoming.find((request) => request.from_user.id === userId);
  if (received) return { kind: 'requestReceived', requestId: received.id };
  const sent = requests.outgoing.find((request) => request.to_user.id === userId);
  if (sent) return { kind: 'requestSent', requestId: sent.id };
  return { kind: 'none' };
}

/** Short status for lists ("Friends", "Request sent"…), null when there is nothing to say. */
export function friendshipLabel(friendship: Friendship): string | null {
  switch (friendship.kind) {
    case 'friends':
      return 'Friends';
    case 'requestSent':
      return 'Request sent';
    case 'requestReceived':
      return 'Wants to be your friend';
    case 'self':
      return 'You';
    case 'none':
      return null;
  }
}
