import type { SqlDatabase, SqlExecutor, SqlRunResult, SqlValue } from '../platform';
import { SerialQueue } from '../utils/serialQueue';
import { ChangeNotifier } from './changes';
import type { RepoContext } from './context';
import { migrate } from './migrations';
import { ContactIdentitiesRepository } from './repositories/contactIdentities';
import { ConversationsRepository } from './repositories/conversations';
import { HistoryTransfersRepository } from './repositories/historyTransfers';
import { MessagesRepository } from './repositories/messages';
import { OutboxRepository } from './repositories/outbox';
import { ReceiptHintsRepository } from './repositories/receiptHints';

/** The repositories, bound either to the store (auto-commit) or to one open transaction. */
export interface Repositories {
  readonly conversations: ConversationsRepository;
  readonly messages: MessagesRepository;
  readonly outbox: OutboxRepository;
  readonly receiptHints: ReceiptHintsRepository;
  readonly contactIdentities: ContactIdentitiesRepository;
  readonly historyTransfers: HistoryTransfersRepository;
  /** Raw SQL for queries no repository offers yet (same transaction/locking rules). */
  readonly sql: SqlExecutor;
}

function bindRepositories(ctx: RepoContext): Repositories {
  return {
    conversations: new ConversationsRepository(ctx),
    messages: new MessagesRepository(ctx),
    outbox: new OutboxRepository(ctx),
    receiptHints: new ReceiptHintsRepository(ctx),
    contactIdentities: new ContactIdentitiesRepository(ctx),
    historyTransfers: new HistoryTransfersRepository(ctx),
    sql: ctx.sql,
  };
}

/**
 * The user's local database (protocol §12): migrations, serialised access and change notifications.
 *
 * expo-sqlite's withTransactionAsync is not exclusive — any query issued while it is open joins the
 * transaction. Every statement therefore goes through one queue, and a transaction holds the queue
 * until it commits. Consequence for callers: inside `transaction(fn)` use only the `tx` argument;
 * calling `store.*` there would wait for the transaction itself and deadlock.
 */
export class LocalStore implements Repositories {
  readonly changes: ChangeNotifier;
  readonly conversations: ConversationsRepository;
  readonly messages: MessagesRepository;
  readonly outbox: OutboxRepository;
  readonly receiptHints: ReceiptHintsRepository;
  readonly contactIdentities: ContactIdentitiesRepository;
  readonly historyTransfers: HistoryTransfersRepository;
  readonly sql: SqlExecutor;
  private readonly queue = new SerialQueue();
  private closed = false;

  private constructor(
    private readonly db: SqlDatabase,
    changes: ChangeNotifier,
  ) {
    this.changes = changes;
    const store = this;
    const queued: SqlExecutor = {
      execAsync: (sql) => store.enqueue(() => db.execAsync(sql)),
      runAsync: (sql, params) => store.enqueue<SqlRunResult>(() => db.runAsync(sql, params)),
      getAllAsync: <T>(sql: string, params?: readonly SqlValue[]) => store.enqueue<T[]>(() => db.getAllAsync<T>(sql, params)),
      getFirstAsync: <T>(sql: string, params?: readonly SqlValue[]) =>
        store.enqueue<T | null>(() => db.getFirstAsync<T>(sql, params)),
    };
    const repos = bindRepositories({
      sql: queued,
      // Auto-commit statements are durable as soon as they resolve, so notify right away.
      changed: (...topics) => store.changes.notify(topics),
      atomic: (fn) => store.transaction((_tx, ctx) => fn(ctx)),
    });
    this.conversations = repos.conversations;
    this.messages = repos.messages;
    this.outbox = repos.outbox;
    this.receiptHints = repos.receiptHints;
    this.contactIdentities = repos.contactIdentities;
    this.historyTransfers = repos.historyTransfers;
    this.sql = repos.sql;
  }

  /** Runs pending migrations and returns a ready store. Closes `db` if migration fails. */
  static async open(db: SqlDatabase, changes = new ChangeNotifier()): Promise<LocalStore> {
    try {
      await migrate(db);
    } catch (error) {
      await db.closeAsync().catch((closeError: unknown) => {
        console.error('Closing the database after a failed migration also failed', closeError);
      });
      throw error;
    }
    return new LocalStore(db, changes);
  }

  /**
   * Runs `fn` in one SQLite transaction. Change notifications are emitted only after COMMIT and are
   * discarded on rollback.
   */
  transaction<T>(fn: (tx: Repositories, ctx: RepoContext) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const topics = new Set<string>();
      let active = true;
      const guard = <R>(run: () => Promise<R>): Promise<R> => {
        if (!active) return Promise.reject(new Error('Transaction already finished; use the store instead'));
        return run();
      };
      const db = this.db;
      const sql: SqlExecutor = {
        execAsync: (s) => guard(() => db.execAsync(s)),
        runAsync: (s, p) => guard(() => db.runAsync(s, p)),
        getAllAsync: <R>(s: string, p?: readonly SqlValue[]) => guard(() => db.getAllAsync<R>(s, p)),
        getFirstAsync: <R>(s: string, p?: readonly SqlValue[]) => guard(() => db.getFirstAsync<R>(s, p)),
      };
      const ctx: RepoContext = {
        sql,
        changed: (...t) => t.forEach((topic) => topics.add(topic)),
        atomic: (inner) => inner(ctx),
      };
      let result: T;
      try {
        await db.withTransactionAsync(async () => {
          result = await fn(bindRepositories(ctx), ctx);
        });
      } finally {
        active = false;
      }
      this.changes.notify(topics);
      return result!;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue.run(() => this.db.closeAsync());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The local database is closed'));
    return this.queue.run(task);
  }
}
