import type { SqlDatabase, SqlExecutor } from '../platform';
import { SCHEMA_V1 } from './schema';

/**
 * Schema migrations tracked with PRAGMA user_version. MIGRATIONS[i] upgrades version i to i + 1;
 * append new steps, never edit shipped ones.
 */
const MIGRATIONS: ((sql: SqlExecutor) => Promise<void>)[] = [(sql) => sql.execAsync(SCHEMA_V1)];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export async function getSchemaVersion(sql: SqlExecutor): Promise<number> {
  const row = await sql.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  return row?.user_version ?? 0;
}

/** Brings the database to LATEST_SCHEMA_VERSION; each step commits together with its version bump. */
export async function migrate(db: SqlDatabase): Promise<{ from: number; to: number }> {
  const from = await getSchemaVersion(db);
  if (from > LATEST_SCHEMA_VERSION) {
    // Written by a newer app version; running older code against it could corrupt data.
    throw new MigrationError(`Database schema ${from} is newer than this app supports (${LATEST_SCHEMA_VERSION})`);
  }
  for (let version = from; version < LATEST_SCHEMA_VERSION; version++) {
    await db.withTransactionAsync(async () => {
      await MIGRATIONS[version](db);
      // PRAGMA does not accept bound parameters; `version + 1` is an integer we computed.
      await db.execAsync(`PRAGMA user_version = ${version + 1}`);
    });
  }
  return { from, to: LATEST_SCHEMA_VERSION };
}
