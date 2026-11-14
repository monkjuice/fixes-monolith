import { isSignedOutError } from '../api/errors';
import type { User } from '../api/types';
import type { LocalStore } from '../db/localStore';
import type { Logger } from '../logger';
import type { Clock } from '../platform';

export interface ProfilesApi {
  getUsersByIds(ids: readonly string[]): Promise<{ users: User[] }>;
}

const IDS_PER_CALL = 100;

/**
 * Peer names and avatars (protocol §13 "Inbox refresh"): refreshed with `GET /v1/users?ids=` when the
 * inbox gains focus (at most once a minute) and after imports; placeholder conversations of unknown
 * peers are filled in the background.
 */
export class PeerProfiles {
  private lastRefreshAt: number | null = null;
  private readonly inflight = new Set<string>();
  private stopped = false;

  constructor(
    private readonly options: {
      api: ProfilesApi;
      store: LocalStore;
      clock: Clock;
      logger: Logger;
      minIntervalMs: number;
    },
  ) {}

  stop(): void {
    this.stopped = true;
  }

  /** Refreshes every conversation's peer; skipped when the last refresh is under a minute old. */
  async refreshAll(options: { force?: boolean } = {}): Promise<boolean> {
    const now = this.options.clock.now();
    if (!options.force && this.lastRefreshAt !== null && now - this.lastRefreshAt < this.options.minIntervalMs) {
      return false;
    }
    this.lastRefreshAt = now;
    await this.fetch(await this.options.store.conversations.listPeerIds());
    return true;
  }

  /** Fire-and-forget fetch for peers that just got a placeholder conversation. */
  fetchInBackground(ids: Iterable<string>): void {
    const wanted = [...new Set(ids)].filter((id) => !this.inflight.has(id));
    if (wanted.length === 0 || this.stopped) return;
    wanted.forEach((id) => this.inflight.add(id));
    void this.fetch(wanted)
      .catch((error: unknown) => {
        // The next inbox refresh retries; the placeholder name stays until then.
        if (!this.stopped && !isSignedOutError(error)) this.options.logger.warn('Could not fetch peer profiles', error);
      })
      .finally(() => wanted.forEach((id) => this.inflight.delete(id)));
  }

  private async fetch(ids: readonly string[]): Promise<void> {
    for (let i = 0; i < ids.length && !this.stopped; i += IDS_PER_CALL) {
      const { users } = await this.options.api.getUsersByIds(ids.slice(i, i + IDS_PER_CALL));
      if (this.stopped) return;
      const requested = new Set(ids);
      const now = this.options.clock.now();
      await this.options.store.transaction(async (tx) => {
        for (const user of users) {
          // Only the users asked for: a server answer cannot rename other conversations.
          if (requested.has(user.id)) await tx.conversations.updateProfile(user.id, user.username, user.avatar_url, now);
        }
      });
    }
  }
}
