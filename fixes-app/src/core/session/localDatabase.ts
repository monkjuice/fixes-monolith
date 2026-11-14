import { randomBytes } from '../crypto/random';
import { toHex } from '../crypto/encoding';
import { LocalStore } from '../db/localStore';
import type { DatabaseOpener } from '../platform';
import type { SecureItems } from './secureItems';

export interface OpenedLocalStore {
  store: LocalStore;
  /**
   * True when a database file existed without its key in secure storage (restored from an OS
   * backup, §12.1): the file was moved aside and the store starts empty. The UI should offer backup
   * import and device linking.
   */
  movedAside: boolean;
}

/**
 * Opens `fixes-<user_id>.db` with its SQLCipher key (`fixes.dbkey.<user_id>`, 32 random bytes as hex),
 * creating the key on first use.
 */
export async function openLocalStore(
  userId: string,
  items: SecureItems,
  opener: DatabaseOpener,
): Promise<OpenedLocalStore> {
  let keyHex = await items.getDbKey(userId);
  let movedAside = false;
  if (keyHex === null) {
    if (await opener.exists(userId)) {
      await opener.moveAside(userId);
      movedAside = true;
    }
    keyHex = toHex(randomBytes(32));
    // Stored before the file is created: a crash in between leaves a key without a file, which is harmless.
    await items.setDbKey(userId, keyHex);
  }
  const db = await opener.open(userId, keyHex);
  const store = await LocalStore.open(db);
  return { store, movedAside };
}
