import { Topics } from '../changes';
import type { RepoContext } from '../context';
import type { ContactIdentityRow } from '../types';

/** Pinned contact AIKs (TOFU, protocol §8). */
export class ContactIdentitiesRepository {
  constructor(private readonly ctx: RepoContext) {}

  get(userId: string): Promise<ContactIdentityRow | null> {
    return this.ctx.sql.getFirstAsync<ContactIdentityRow>('SELECT * FROM contact_identities WHERE user_id = ?', [userId]);
  }

  list(): Promise<ContactIdentityRow[]> {
    return this.ctx.sql.getAllAsync<ContactIdentityRow>('SELECT * FROM contact_identities ORDER BY user_id');
  }

  /** Pins on first use; an existing pin always wins (§8, §10). Returns true when a new pin was stored. */
  async pinIfAbsent(userId: string, identityKey: string, firstSeenAt: number, verified = false): Promise<boolean> {
    const result = await this.ctx.sql.runAsync(
      `INSERT INTO contact_identities (user_id, identity_key, first_seen_at, verified) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO NOTHING`,
      [userId, identityKey, firstSeenAt, verified ? 1 : 0],
    );
    if (result.changes > 0) this.ctx.changed(Topics.contacts);
    return result.changes > 0;
  }

  /** Records a changed AIK awaiting the user's Accept (sending stays blocked meanwhile). */
  async setPending(userId: string, pendingIdentityKey: string): Promise<boolean> {
    const result = await this.ctx.sql.runAsync(
      `UPDATE contact_identities SET pending_identity_key = ?
       WHERE user_id = ? AND identity_key != ? AND (pending_identity_key IS NULL OR pending_identity_key != ?)`,
      [pendingIdentityKey, userId, pendingIdentityKey, pendingIdentityKey],
    );
    if (result.changes > 0) this.ctx.changed(Topics.contacts);
    return result.changes > 0;
  }

  /** User tapped Accept: the pending key becomes the pin, unverified (§8). */
  async acceptPending(userId: string): Promise<boolean> {
    const result = await this.ctx.sql.runAsync(
      `UPDATE contact_identities
       SET identity_key = pending_identity_key, pending_identity_key = NULL, verified = 0
       WHERE user_id = ? AND pending_identity_key IS NOT NULL`,
      [userId],
    );
    if (result.changes > 0) this.ctx.changed(Topics.contacts);
    return result.changes > 0;
  }

  async setVerified(userId: string, verified: boolean): Promise<void> {
    const result = await this.ctx.sql.runAsync('UPDATE contact_identities SET verified = ? WHERE user_id = ?', [
      verified ? 1 : 0,
      userId,
    ]);
    if (result.changes > 0) this.ctx.changed(Topics.contacts);
  }
}
