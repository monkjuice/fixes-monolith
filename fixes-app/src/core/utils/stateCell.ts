import type { Unsubscribe } from '../events';

/**
 * A value that can be observed. `get` and `subscribe` are bound arrow functions so they can be passed
 * straight to React's useSyncExternalStore; `set` notifies only when the value actually changes.
 */
export class StateCell<T> {
  private readonly listeners = new Set<(state: T) => void>();

  constructor(private state: T) {}

  readonly get = (): T => this.state;

  readonly subscribe = (listener: (state: T) => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  set(next: T): void {
    if (Object.is(next, this.state)) return;
    this.state = next;
    for (const listener of [...this.listeners]) {
      try {
        listener(next);
      } catch (error) {
        // Listeners belong to the UI; one failing must not break the engine or the other listeners.
        console.error('State listener failed', error);
      }
    }
  }

  update(patch: Partial<T>): void {
    this.set({ ...this.state, ...patch });
  }
}
