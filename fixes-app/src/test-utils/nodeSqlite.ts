import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import {
  DATABASE_SIDE_SUFFIXES,
  databaseFileName,
  isDatabaseFileOf,
  movedAsideFileName,
} from '../core/db/files';
import type { DatabaseOpener, SqlDatabase, SqlRunResult, SqlValue } from '../core/platform';

/**
 * SqlDatabase over better-sqlite3 for Jest and the e2e suite. Plain SQLite: there is no SQLCipher in
 * Node, so the opener below records the key instead of applying it (the key handshake itself is
 * covered by core/db/sqlcipher tests with a fake connection).
 */

function bind(params: readonly SqlValue[] | undefined): unknown[] {
  return (params ?? []).map((p) => (p instanceof Uint8Array ? Buffer.from(p) : p));
}

/**
 * better-sqlite3's native addon is loaded once per process and keeps the SqliteError constructor of the
 * first JavaScript realm that loaded it. Under Jest every test file is a new realm, so later files get
 * errors that are not `instanceof Error` there (and SqliteError has no internal error slot either).
 * Rethrowing a realm-local Error keeps message, code and cause intact for every caller.
 */
function toLocalError(error: unknown): unknown {
  if (error instanceof Error || typeof error !== 'object' || error === null) return error;
  const source = error as { message?: unknown; code?: unknown; name?: unknown };
  const local = new Error(String(source.message ?? 'SQLite error'), { cause: error }) as Error & { code?: string };
  local.name = typeof source.name === 'string' ? source.name : 'SqliteError';
  if (typeof source.code === 'string') local.code = source.code;
  return local;
}

function sync<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw toLocalError(error);
  }
}

export function wrapBetterSqlite(db: Database.Database): SqlDatabase {
  return {
    async execAsync(sql) {
      sync(() => db.exec(sql));
    },
    async runAsync(sql, params): Promise<SqlRunResult> {
      return sync(() => {
        const stmt = db.prepare(sql);
        if (stmt.reader) {
          // Statements with RETURNING still have to be stepped to completion.
          stmt.all(...bind(params));
          const info = db.prepare('SELECT changes() AS changes, last_insert_rowid() AS id').get() as {
            changes: number;
            id: number;
          };
          return { changes: info.changes, lastInsertRowId: Number(info.id) };
        }
        const result = stmt.run(...bind(params));
        return { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) };
      });
    },
    async getAllAsync<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]> {
      return sync(() => {
        const stmt = db.prepare(sql);
        if (!stmt.reader) {
          stmt.run(...bind(params));
          return [];
        }
        return stmt.all(...bind(params)) as T[];
      });
    },
    async getFirstAsync<T>(sql: string, params?: readonly SqlValue[]): Promise<T | null> {
      return sync(() => {
        const stmt = db.prepare(sql);
        if (!stmt.reader) {
          stmt.run(...bind(params));
          return null;
        }
        return (stmt.get(...bind(params)) as T | undefined) ?? null;
      });
    },
    async withTransactionAsync(task) {
      sync(() => db.exec('BEGIN'));
      try {
        await task();
        sync(() => db.exec('COMMIT'));
      } catch (error) {
        if (db.inTransaction) sync(() => db.exec('ROLLBACK'));
        throw error;
      }
    },
    async closeAsync() {
      if (db.open) sync(() => db.close());
    },
  };
}

/** An in-memory database (no file), for repository tests. */
export function openMemoryDatabase(): SqlDatabase {
  return wrapBetterSqlite(new Database(':memory:'));
}

export interface NodeDatabaseOpener extends DatabaseOpener {
  readonly directory: string;
  /** Keys passed to open(), by user id (lets tests assert the DB key handling). */
  readonly keysUsed: Map<string, string>;
}

/** File-backed opener in `directory`, mirroring the Expo opener's naming and move-aside behaviour. */
export function createNodeDatabaseOpener(directory: string, now: () => number = Date.now): NodeDatabaseOpener {
  const keysUsed = new Map<string, string>();
  const file = (userId: string) => path.join(directory, databaseFileName(userId));
  return {
    directory,
    keysUsed,
    async open(userId, keyHex) {
      fs.mkdirSync(directory, { recursive: true });
      keysUsed.set(userId, keyHex);
      return wrapBetterSqlite(new Database(file(userId)));
    },
    async exists(userId) {
      return fs.existsSync(file(userId));
    },
    async moveAside(userId) {
      const target = path.join(directory, movedAsideFileName(userId, now()));
      for (const suffix of ['', ...DATABASE_SIDE_SUFFIXES]) {
        const source = file(userId) + suffix;
        if (fs.existsSync(source)) fs.renameSync(source, target + suffix);
      }
    },
    async delete(userId) {
      if (!fs.existsSync(directory)) return;
      for (const name of fs.readdirSync(directory)) {
        if (isDatabaseFileOf(userId, name)) fs.rmSync(path.join(directory, name), { force: true });
      }
    },
  };
}
