import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { FriendRequestsResponse } from '../../core/api/types';
import { useFixes, useSession } from '../../hooks';
import { reportBackgroundError } from '../presentation/errors';
import { useAppActive } from './useAppActive';

/**
 * Friend requests have no realtime event (§6), so the count is polled while the app is in the
 * foreground; screens that change requests call `refresh()` or `report()` for an immediate update.
 */
export const FRIEND_REQUEST_POLL_MS = 60_000;

export interface FriendRequestCount {
  /** Incoming requests waiting for an answer (Profile tab badge). */
  incoming: number;
  /** Fetch again now. */
  refresh(): void;
  /** A screen just loaded the requests itself: use its answer instead of fetching. */
  report(requests: FriendRequestsResponse): void;
}

const FriendRequestCountContext = createContext<FriendRequestCount>({
  incoming: 0,
  refresh: () => undefined,
  report: () => undefined,
});

interface Counted {
  userId: string | null;
  incoming: number;
}

export function FriendRequestCountProvider({ children }: { children: ReactNode }) {
  const { session } = useFixes();
  const { status, user } = useSession();
  const active = useAppActive();
  const userId = status === 'ready' ? (user?.id ?? null) : null;
  const [counted, setCounted] = useState<Counted>({ userId: null, incoming: 0 });
  const [request, setRequest] = useState(0);

  useEffect(() => {
    if (userId === null || !active) return;
    let current = true;
    const load = () => {
      session.api.listFriendRequests().then(
        (requests) => {
          if (current) setCounted({ userId, incoming: requests.incoming.length });
        },
        (error: unknown) => reportBackgroundError('Loading friend requests', error),
      );
    };
    load();
    const timer = setInterval(load, FRIEND_REQUEST_POLL_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [session, userId, active, request]);

  const refresh = useCallback(() => setRequest((n) => n + 1), []);
  const report = useCallback(
    (requests: FriendRequestsResponse) => {
      if (userId !== null) setCounted({ userId, incoming: requests.incoming.length });
    },
    [userId],
  );

  // A count fetched for another account (logout, then login as someone else) is never shown.
  const incoming = userId !== null && counted.userId === userId ? counted.incoming : 0;
  const value = useMemo(() => ({ incoming, refresh, report }), [incoming, refresh, report]);
  return <FriendRequestCountContext.Provider value={value}>{children}</FriendRequestCountContext.Provider>;
}

export function useFriendRequestCount(): FriendRequestCount {
  return useContext(FriendRequestCountContext);
}
