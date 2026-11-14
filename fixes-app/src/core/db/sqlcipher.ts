import type { SqlExecutor } from '../platform';

export class DatabaseKeyError extends Error {
  readonly code: 'invalid_key_format' | 'sqlcipher_missing' | 'wrong_key';

  constructor(code: DatabaseKeyError['code'], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DatabaseKeyError';
    this.code = code;
  }
}

const KEY_HEX = /^[0-9a-f]{64}$/;

export function isDatabaseKeyHex(value: unknown): value is string {
  return typeof value === 'string' && KEY_HEX.test(value);
}

/**
 * Applies the 32-byte key to a freshly opened SQLCipher connection (protocol §12.1). Must be the first
 * statement on the connection. The key is passed as a raw key (`x'…'`), so SQLCipher skips its
 * passphrase KDF — the key is already uniformly random.
 *
 * Refuses to continue when `PRAGMA cipher_version` is empty: that means the native build is plain
 * SQLite and would silently write an unencrypted database.
 */
export async function applyDatabaseKey(sql: SqlExecutor, keyHex: string): Promise<void> {
  // PRAGMA cannot take bound parameters, so the value is interpolated; the strict format check
  // above is what keeps this from being an injection point.
  if (!isDatabaseKeyHex(keyHex)) {
    throw new DatabaseKeyError('invalid_key_format', 'Database key must be 64 lowercase hex characters');
  }
  await sql.execAsync(`PRAGMA key = "x'${keyHex}'"`);
  const row = await sql.getFirstAsync<{ cipher_version?: string | null }>('PRAGMA cipher_version');
  const version = row?.cipher_version;
  if (typeof version !== 'string' || version.trim().length === 0) {
    throw new DatabaseKeyError('sqlcipher_missing', 'SQLCipher is not available; refusing to open an unencrypted database');
  }
  try {
    // The key is only checked when the first page is read.
    await sql.getFirstAsync('SELECT count(*) AS n FROM sqlite_master');
  } catch (cause) {
    throw new DatabaseKeyError('wrong_key', 'The database key does not open this database', { cause });
  }
}
