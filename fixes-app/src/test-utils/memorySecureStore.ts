import type { SecureKeyValueStore } from '../core/platform';

export type SecureStoreOperation =
  | { op: 'set'; key: string; value: string }
  | { op: 'delete'; key: string };

/** In-memory SecureKeyValueStore that also records writes, so tests can assert their order. */
export class MemorySecureStore implements SecureKeyValueStore {
  readonly items = new Map<string, string>();
  readonly log: SecureStoreOperation[] = [];
  /** Set to make the next writes fail (simulates a keychain error). */
  failWrites = false;

  async getItem(key: string): Promise<string | null> {
    return this.items.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    if (this.failWrites) throw new Error(`Simulated secure storage failure for ${key}`);
    this.items.set(key, value);
    this.log.push({ op: 'set', key, value });
  }

  async deleteItem(key: string): Promise<void> {
    if (this.failWrites) throw new Error(`Simulated secure storage failure for ${key}`);
    this.items.delete(key);
    this.log.push({ op: 'delete', key });
  }
}
