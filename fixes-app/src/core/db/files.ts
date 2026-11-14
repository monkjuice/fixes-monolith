import { isUuidV4 } from '../crypto/random';

/** File naming shared by every DatabaseOpener implementation (protocol §12.2: one file per user). */

export function databaseFileName(userId: string): string {
  // The user id becomes part of a path: accept nothing but a canonical UUIDv4.
  if (!isUuidV4(userId)) throw new RangeError('Invalid user id');
  return `fixes-${userId}.db`;
}

/** SQLite's companion files that must move/delete together with the database. */
export const DATABASE_SIDE_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

/** Name for a database moved aside because its key was missing (§12.1). */
export function movedAsideFileName(userId: string, now: number): string {
  return `${databaseFileName(userId)}.orphaned-${now}`;
}

/** True for the database file, its side files and moved-aside copies of this user. */
export function isDatabaseFileOf(userId: string, fileName: string): boolean {
  const base = databaseFileName(userId);
  return fileName === base || fileName.startsWith(`${base}-`) || fileName.startsWith(`${base}.orphaned-`);
}
