import type { SqlExecutor, SqlValue } from '../platform';

/** What a repository needs: a statement executor, a way to announce changes, and atomic grouping. */
export interface RepoContext {
  readonly sql: SqlExecutor;
  /** Queues change topics; they are emitted once the surrounding statement or transaction commits. */
  changed(...topics: string[]): void;
  /** Runs `fn` atomically: directly when already inside a transaction, otherwise as its own transaction. */
  atomic<T>(fn: (ctx: RepoContext) => Promise<T>): Promise<T>;
}

/** `?, ?, ?` for an IN list. Callers must pass at least one value. */
export function placeholders(values: readonly SqlValue[]): string {
  if (values.length === 0) throw new RangeError('IN list needs at least one value');
  return values.map(() => '?').join(', ');
}

// SQLite's default limit on bound parameters is 32766 on modern builds but 999 on old ones; chunking
// keeps large id lists (receipts carry up to 500) safe everywhere.
export const MAX_IN_LIST = 400;

export function chunk<T>(values: readonly T[], size = MAX_IN_LIST): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}
