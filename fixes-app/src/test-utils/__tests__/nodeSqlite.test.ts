import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { uuidv4 } from '../../core/crypto/random';
import { databaseFileName } from '../../core/db/files';
import { LocalStore } from '../../core/db/localStore';
import { createNodeDatabaseOpener, openMemoryDatabase } from '../nodeSqlite';

describe('better-sqlite3 adapter', () => {
  it('implements run/get/all/exec and RETURNING', async () => {
    const db = openMemoryDatabase();
    await db.execAsync('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT, b BLOB)');
    const first = await db.runAsync('INSERT INTO t (v, b) VALUES (?, ?)', ['a', Uint8Array.from([1, 2])]);
    expect(first).toEqual({ changes: 1, lastInsertRowId: 1 });
    await db.runAsync('INSERT INTO t (v) VALUES (?)', ['b']);
    expect(await db.getAllAsync<{ v: string }>('SELECT v FROM t ORDER BY id')).toEqual([{ v: 'a' }, { v: 'b' }]);
    expect(await db.getFirstAsync('SELECT v FROM t WHERE id = ?', [99])).toBeNull();
    const returned = await db.getAllAsync<{ id: number }>("UPDATE t SET v = 'z' RETURNING id");
    expect(returned).toHaveLength(2);
    const viaRun = await db.runAsync("DELETE FROM t WHERE v = 'z' RETURNING id");
    expect(viaRun.changes).toBe(2);
  });

  it('rolls back failed transactions', async () => {
    const db = openMemoryDatabase();
    await db.execAsync('CREATE TABLE t (v TEXT)');
    await expect(
      db.withTransactionAsync(async () => {
        await db.runAsync('INSERT INTO t VALUES (?)', ['x']);
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    expect(await db.getAllAsync('SELECT * FROM t')).toEqual([]);
  });
});

describe('Node database opener', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixes-opener-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('opens, moves aside and deletes per-user files', async () => {
    const userId = uuidv4();
    let t = 1000;
    const opener = createNodeDatabaseOpener(dir, () => t++);
    expect(await opener.exists(userId)).toBe(false);
    const store = await LocalStore.open(await opener.open(userId, 'ab'.repeat(32)));
    await store.close();
    expect(await opener.exists(userId)).toBe(true);
    await opener.moveAside(userId);
    expect(await opener.exists(userId)).toBe(false);
    expect(fs.readdirSync(dir)).toContain(`${databaseFileName(userId)}.orphaned-1000`);
    const other = uuidv4();
    await (await opener.open(other, 'cd'.repeat(32))).closeAsync();
    await opener.delete(userId);
    expect(fs.readdirSync(dir)).toEqual([databaseFileName(other)]);
  });
});
