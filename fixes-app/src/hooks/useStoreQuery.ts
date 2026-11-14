import { useMemo, useSyncExternalStore } from 'react';

import { QueryObserver, type QueryState } from '../core/db/liveQuery';
import type { LocalStore } from '../core/db/localStore';

export type StoreQuery<T> = QueryState<T> & { reload(): void };

/**
 * Runs `run` against the local database and again after every commit that touches one of `topics`.
 * `run` and `initial` must be stable (module-level functions/constants or useCallback).
 */
export function useStoreQuery<T>(
  store: LocalStore | null,
  topics: readonly string[],
  run: (store: LocalStore) => Promise<T>,
  initial: T,
): StoreQuery<T> {
  const topicsKey = topics.join('\n');
  const observer = useMemo(
    () => new QueryObserver(store, topicsKey.split('\n'), run, initial),
    [store, topicsKey, run, initial],
  );
  const state = useSyncExternalStore(observer.subscribe, observer.getSnapshot, observer.getSnapshot);
  return useMemo(() => ({ ...state, reload: observer.reload }), [state, observer]);
}
