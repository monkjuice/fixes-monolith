import * as SQLite from 'expo-sqlite';

import { DatabaseKeyError } from '../../core/db/sqlcipher';
import { expoDatabaseOpener } from '../database';

const USER = '3f2b8a8e-4c1d-4a8e-9f3e-2b7c1d0e9a11';
const KEY = 'ab'.repeat(32);

interface MockDb {
  statements: string[];
  cipherVersion: string | null;
  execAsync: jest.Mock;
  getFirstAsync: jest.Mock;
  closeAsync: jest.Mock;
}

const mockDb: MockDb = {
  statements: [] as string[],
  cipherVersion: '4.6.1 community' as string | null,
  execAsync: jest.fn(async (sql: string) => {
    mockDb.statements.push(sql);
  }),
  getFirstAsync: jest.fn(async (sql: string): Promise<object | null> => {
    mockDb.statements.push(sql);
    if (sql === 'PRAGMA cipher_version') return mockDb.cipherVersion === null ? null : { cipher_version: mockDb.cipherVersion };
    return { n: 0 };
  }),
  closeAsync: jest.fn(async () => undefined),
};

jest.mock('expo-sqlite', () => ({
  defaultDatabaseDirectory: '/data/user/0/app.fixes.mobile/files/SQLite',
  openDatabaseAsync: jest.fn(async () => mockDb),
}));

jest.mock('expo-file-system', () => ({ File: class {}, Directory: class {} }));

describe('expoDatabaseOpener', () => {
  beforeEach(() => {
    mockDb.statements = [];
    mockDb.cipherVersion = '4.6.1 community';
    jest.clearAllMocks();
  });

  it('opens fixes-<user_id>.db and applies PRAGMA key before anything else', async () => {
    await expoDatabaseOpener.open(USER, KEY);
    expect(SQLite.openDatabaseAsync).toHaveBeenCalledWith(`fixes-${USER}.db`);
    expect(mockDb.statements[0]).toBe(`PRAGMA key = "x'${KEY}'"`);
    expect(mockDb.statements[1]).toBe('PRAGMA cipher_version');
  });

  it('refuses (and closes) when the build has no SQLCipher', async () => {
    mockDb.cipherVersion = '';
    await expect(expoDatabaseOpener.open(USER, KEY)).rejects.toBeInstanceOf(DatabaseKeyError);
    expect(mockDb.closeAsync).toHaveBeenCalled();
  });

  it('never opens a file for an invalid user id', async () => {
    await expect(expoDatabaseOpener.open('../escape', KEY)).rejects.toThrow(RangeError);
    expect(SQLite.openDatabaseAsync).not.toHaveBeenCalled();
  });
});
