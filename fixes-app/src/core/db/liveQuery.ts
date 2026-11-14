import type { Unsubscribe } from '../events';
import type { LocalStore } from './localStore';
import { Topics } from './changes';
import type { MessageCursor } from './repositories/messages';
import type { MessageRow } from './types';

/**
 * Re-running queries for the UI: subscribe to change topics, re-query after every commit, expose the
 * latest result through `subscribe`/`getSnapshot` (useSyncExternalStore). Framework-agnostic so it can
 * be tested without React. Queries start when the first listener subscribes and stop with the last.
 */

abstract class Observer<S> {
  private readonly listeners = new Set<() => void>();
  private unsubscribeTopics: Unsubscribe[] = [];
  // Results of queries started before the latest one (or before stop) are ignored.
  private generation = 0;

  protected constructor(
    protected readonly store: LocalStore | null,
    private readonly topics: readonly string[],
    private snapshot: S,
  ) {}

  readonly subscribe = (listener: () => void): Unsubscribe => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };

  readonly getSnapshot = (): S => this.snapshot;

  /** Re-runs the query now (pull to refresh, or after an action that has no change topic). */
  readonly reload = (): void => {
    this.load();
  };

  protected abstract query(store: LocalStore): Promise<Partial<S>>;
  protected abstract failed(error: Error): Partial<S>;

  protected load(): void {
    const store = this.store;
    if (!store || this.listeners.size === 0) return;
    const generation = ++this.generation;
    this.query(store).then(
      (patch) => {
        if (generation === this.generation) this.set({ ...this.snapshot, ...patch });
      },
      (error: unknown) => {
        if (generation !== this.generation) return;
        // Reported through the snapshot (the UI shows it); a closed store after sign-out also lands here.
        this.set({ ...this.snapshot, ...this.failed(error instanceof Error ? error : new Error(String(error))) });
      },
    );
  }

  protected set(next: S): void {
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }

  protected get current(): S {
    return this.snapshot;
  }

  private start(): void {
    const store = this.store;
    if (!store) return;
    this.unsubscribeTopics = this.topics.map((topic) => store.changes.subscribe(topic, () => this.load()));
    this.load();
  }

  private stop(): void {
    this.generation++;
    for (const unsubscribe of this.unsubscribeTopics.splice(0)) unsubscribe();
  }
}

export interface QueryState<T> {
  data: T;
  /** True until the first result arrived. Later re-queries keep showing the previous data. */
  loading: boolean;
  error: Error | null;
}

export class QueryObserver<T> extends Observer<QueryState<T>> {
  constructor(
    store: LocalStore | null,
    topics: readonly string[],
    private readonly run: (store: LocalStore) => Promise<T>,
    initial: T,
  ) {
    super(store, topics, { data: initial, loading: store !== null, error: null });
  }

  protected async query(store: LocalStore): Promise<Partial<QueryState<T>>> {
    return { data: await this.run(store), loading: false, error: null };
  }

  protected failed(error: Error): Partial<QueryState<T>> {
    return { loading: false, error };
  }
}

export interface MessageWindowState {
  /** Newest first. */
  messages: MessageRow[];
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: Error | null;
}

const PAGE_LIMIT = 500;

/** The newest `count` messages of a conversation (newest first), read page by page. */
export async function loadMessageWindow(store: LocalStore, peerUserId: string, count: number): Promise<MessageRow[]> {
  const rows: MessageRow[] = [];
  let before: MessageCursor | undefined;
  while (rows.length < count) {
    const limit = Math.min(PAGE_LIMIT, count - rows.length);
    const page = await store.messages.listPage(peerUserId, { before, limit });
    rows.push(...page);
    if (page.length < limit) break;
    const last = page[page.length - 1];
    before = { sortTs: last.sort_ts, id: last.id };
  }
  return rows;
}

/** A conversation's newest messages; `loadMore()` widens the window by one page. */
export class MessageWindowObserver extends Observer<MessageWindowState> {
  private limit: number;

  constructor(
    store: LocalStore | null,
    private readonly peerUserId: string,
    private readonly pageSize: number,
  ) {
    super(store, [Topics.messages(peerUserId)], {
      messages: [],
      hasMore: false,
      loading: store !== null,
      loadingMore: false,
      error: null,
    });
    this.limit = pageSize;
  }

  readonly loadMore = (): void => {
    const state = this.current;
    if (!state.hasMore || state.loadingMore) return;
    this.limit += this.pageSize;
    this.set({ ...state, loadingMore: true });
    this.load();
  };

  protected async query(store: LocalStore): Promise<Partial<MessageWindowState>> {
    // One extra row tells whether older messages exist.
    const rows = await loadMessageWindow(store, this.peerUserId, this.limit + 1);
    return {
      messages: rows.slice(0, this.limit),
      hasMore: rows.length > this.limit,
      loading: false,
      loadingMore: false,
      error: null,
    };
  }

  protected failed(error: Error): Partial<MessageWindowState> {
    return { loading: false, loadingMore: false, error };
  }
}
