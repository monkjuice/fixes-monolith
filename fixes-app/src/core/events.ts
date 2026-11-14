export type Unsubscribe = () => void;

/**
 * Minimal typed event emitter. A throwing listener must not stop the others or the emitter's
 * caller (e.g. the socket's message loop), so listener errors are reported to `onListenerError`.
 */
export class Emitter<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<(payload: never) => void>>();

  constructor(private readonly onListenerError: (error: unknown) => void = reportListenerError) {}

  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (payload: never) => void);
    return () => {
      set.delete(listener as (payload: never) => void);
    };
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener as (p: Events[K]) => void)(payload);
      } catch (error) {
        this.onListenerError(error);
      }
    }
  }

  removeAll(): void {
    this.listeners.clear();
  }
}

function reportListenerError(error: unknown): void {
  // Surfacing via console is deliberate: listeners belong to other layers (UI), and a crash here
  // would break unrelated subscribers.
  console.error('Unhandled error in event listener', error);
}
