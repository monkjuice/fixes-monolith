import { useCallback, useMemo, useSyncExternalStore } from 'react';

import { Topics } from '../core/db/changes';
import { MessageWindowObserver, type MessageWindowState } from '../core/db/liveQuery';
import type { LocalStore } from '../core/db/localStore';
import type { ContactIdentityRow, InboxRow } from '../core/db/types';
import { useLocalStore } from './useSession';
import { useStoreQuery, type StoreQuery } from './useStoreQuery';

const INBOX_TOPICS = [Topics.conversations];
const CONTACT_TOPICS = [Topics.contacts];
const NO_CONVERSATIONS: InboxRow[] = [];
const listInbox = (store: LocalStore) => store.conversations.listInbox();

/** Inbox rows sorted by last activity, each with its newest non-system message (§14). */
export function useConversations(): StoreQuery<InboxRow[]> {
  return useStoreQuery(useLocalStore(), INBOX_TOPICS, listInbox, NO_CONVERSATIONS);
}

export type MessagesPage = MessageWindowState & { loadMore(): void; reload(): void };

/**
 * A conversation's messages, newest first, `pageSize` at a time; `loadMore()` adds an older page.
 * Re-queries after every change to the conversation (new rows, status ticks, system messages).
 */
export function useMessages(peerUserId: string, pageSize = 30): MessagesPage {
  const store = useLocalStore();
  const observer = useMemo(() => new MessageWindowObserver(store, peerUserId, pageSize), [store, peerUserId, pageSize]);
  const state = useSyncExternalStore(observer.subscribe, observer.getSnapshot, observer.getSnapshot);
  return useMemo(() => ({ ...state, loadMore: observer.loadMore, reload: observer.reload }), [state, observer]);
}

/** The pinned identity of a contact (safety-code banner while `pending_identity_key` is set, §8). */
export function useContactIdentity(peerUserId: string): StoreQuery<ContactIdentityRow | null> {
  const run = useCallback((store: LocalStore) => store.contactIdentities.get(peerUserId), [peerUserId]);
  return useStoreQuery(useLocalStore(), CONTACT_TOPICS, run, null);
}
