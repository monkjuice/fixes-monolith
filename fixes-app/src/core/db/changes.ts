import type { Unsubscribe } from '../events';

/**
 * Change topics emitted after data is committed. UI hooks subscribe to a topic and re-query; the
 * notification carries no data on purpose, so a missed or merged notification can never show stale rows.
 */
export const Topics = {
  conversations: 'conversations',
  messages: (peerUserId: string) => `messages:${peerUserId}`,
  outbox: 'outbox',
  receiptHints: 'receipt_hints',
  contacts: 'contacts',
  transfers: 'transfers',
} as const;

export type ChangeListener = (topic: string) => void;

export class ChangeNotifier {
  private readonly listeners = new Map<string, Set<ChangeListener>>();

  subscribe(topic: string, listener: ChangeListener): Unsubscribe {
    let set = this.listeners.get(topic);
    if (!set) {
      set = new Set();
      this.listeners.set(topic, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(topic);
    };
  }

  notify(topics: Iterable<string>): void {
    for (const topic of new Set(topics)) {
      const set = this.listeners.get(topic);
      if (!set) continue;
      for (const listener of [...set]) {
        try {
          listener(topic);
        } catch (error) {
          // A failing UI listener must not break the write path that triggered it.
          console.error(`Change listener for "${topic}" failed`, error);
        }
      }
    }
  }
}
