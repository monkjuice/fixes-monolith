import { Directory, File } from 'expo-file-system';
import * as SQLite from 'expo-sqlite';

import {
  DATABASE_SIDE_SUFFIXES,
  databaseFileName,
  isDatabaseFileOf,
  movedAsideFileName,
} from '../core/db/files';
import { applyDatabaseKey } from '../core/db/sqlcipher';
import type { DatabaseOpener, SqlDatabase } from '../core/platform';

/** SqlDatabase over expo-sqlite. Built with SQLCipher (`useSQLCipher` in app.json). */
export function wrapExpoDatabase(db: SQLite.SQLiteDatabase): SqlDatabase {
  return {
    execAsync: (sql) => db.execAsync(sql),
    runAsync: async (sql, params) => {
      const result = await db.runAsync(sql, [...(params ?? [])]);
      return { changes: result.changes, lastInsertRowId: result.lastInsertRowId };
    },
    getAllAsync: (sql, params) => db.getAllAsync(sql, [...(params ?? [])]),
    getFirstAsync: (sql, params) => db.getFirstAsync(sql, [...(params ?? [])]),
    withTransactionAsync: (task) => db.withTransactionAsync(task),
    closeAsync: () => db.closeAsync(),
  };
}

// expo-sqlite reports a plain path; expo-file-system wants a file:// URI.
function databaseDirectory(): Directory {
  return new Directory(`file://${String(SQLite.defaultDatabaseDirectory)}`);
}

function databaseFile(name: string): File {
  return new File(databaseDirectory(), name);
}

/** Opens `fixes-<user_id>.db` in expo-sqlite's default directory with the SQLCipher key (§12.1). */
export const expoDatabaseOpener: DatabaseOpener = {
  async open(userId, keyHex) {
    const db = await SQLite.openDatabaseAsync(databaseFileName(userId));
    const wrapped = wrapExpoDatabase(db);
    try {
      // First statement on the connection; refuses to continue if SQLCipher is missing.
      await applyDatabaseKey(wrapped, keyHex);
    } catch (error) {
      await db.closeAsync().catch((closeError: unknown) => {
        console.error('Closing the database after a key failure also failed', closeError);
      });
      throw error;
    }
    return wrapped;
  },

  async exists(userId) {
    return databaseFile(databaseFileName(userId)).exists;
  },

  async moveAside(userId) {
    const name = databaseFileName(userId);
    const target = movedAsideFileName(userId, Date.now());
    for (const suffix of ['', ...DATABASE_SIDE_SUFFIXES]) {
      const source = databaseFile(name + suffix);
      if (source.exists) await source.move(databaseFile(target + suffix));
    }
  },

  async delete(userId) {
    const directory = databaseDirectory();
    if (!directory.exists) return;
    for (const entry of directory.list()) {
      if (entry instanceof File && isDatabaseFileOf(userId, entry.name)) entry.delete();
    }
  },
};
