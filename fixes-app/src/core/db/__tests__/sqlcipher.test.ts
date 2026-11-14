import type { SqlExecutor } from '../../platform';
import { applyDatabaseKey, DatabaseKeyError } from '../sqlcipher';

function fakeConnection(options: { cipherVersion: string | null; keyWorks?: boolean }) {
  const statements: string[] = [];
  const sql: SqlExecutor = {
    async execAsync(s) {
      statements.push(s);
    },
    async runAsync(s) {
      statements.push(s);
      return { changes: 0, lastInsertRowId: 0 };
    },
    async getAllAsync() {
      return [];
    },
    async getFirstAsync<T>(s: string): Promise<T | null> {
      statements.push(s);
      if (s === 'PRAGMA cipher_version') {
        return (options.cipherVersion === null ? null : ({ cipher_version: options.cipherVersion } as T)) ?? null;
      }
      if (options.keyWorks === false) throw new Error('file is not a database');
      return { n: 0 } as T;
    },
  };
  return { sql, statements };
}

const KEY = 'a'.repeat(64);

describe('applyDatabaseKey (§12.1)', () => {
  it('sends PRAGMA key first, as a raw key, then checks cipher_version and the key', async () => {
    const { sql, statements } = fakeConnection({ cipherVersion: '4.6.1 community' });
    await applyDatabaseKey(sql, KEY);
    expect(statements).toEqual([`PRAGMA key = "x'${KEY}'"`, 'PRAGMA cipher_version', 'SELECT count(*) AS n FROM sqlite_master']);
  });

  it.each([null, '', '   '])('refuses to continue when cipher_version is %p (plain SQLite)', async (version) => {
    const { sql } = fakeConnection({ cipherVersion: version });
    await expect(applyDatabaseKey(sql, KEY)).rejects.toMatchObject({ code: 'sqlcipher_missing' });
  });

  it('reports a key that does not open the file', async () => {
    const { sql } = fakeConnection({ cipherVersion: '4.6.1', keyWorks: false });
    await expect(applyDatabaseKey(sql, KEY)).rejects.toMatchObject({ code: 'wrong_key' });
  });

  it.each(['', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(62)}'"`, 'g'.repeat(64)])(
    'rejects malformed keys before building SQL: %p',
    async (bad) => {
      const { sql, statements } = fakeConnection({ cipherVersion: '4.6.1' });
      await expect(applyDatabaseKey(sql, bad)).rejects.toBeInstanceOf(DatabaseKeyError);
      expect(statements).toEqual([]);
    },
  );
});
