import type { Repositories } from '../db/localStore';

/**
 * Conversation rows for peers the device has not seen yet get this name until the profile fetch
 * (`GET /v1/users?ids=`) replaces it (protocol §13).
 */
export const PLACEHOLDER_PEER_NAME = 'Unknown user';

/** Creates a placeholder conversation when missing. Returns true when one was created. */
export function ensureConversation(tx: Repositories, peerUserId: string, lastActivityAt: number): Promise<boolean> {
  return tx.conversations.insertIfMissing({
    peerUserId,
    peerUsername: PLACEHOLDER_PEER_NAME,
    peerAvatarUrl: null,
    lastActivityAt,
  });
}

/** How every undecryptable-message notice ends (usernames have no spaces, so no name can fake it). */
export const UNDECRYPTABLE_SUFFIX = ' could not be decrypted';

/**
 * §13: the system message for envelopes from a known contact that could not be decrypted; `count`
 * consecutive failures share one notice.
 */
export function undecryptableText(username: string, count = 1): string {
  return count === 1
    ? `A message from ${username}${UNDECRYPTABLE_SUFFIX}`
    : `${count} messages from ${username}${UNDECRYPTABLE_SUFFIX}`;
}

/** The count an undecryptable-message notice shows (its body is the only place it is kept), or null. */
export function undecryptableCount(body: string): number | null {
  if (!body.endsWith(UNDECRYPTABLE_SUFFIX)) return null;
  if (body.startsWith('A message from ')) return 1;
  const match = /^([1-9]\d*) messages from /.exec(body);
  return match ? Number(match[1]) : null;
}
