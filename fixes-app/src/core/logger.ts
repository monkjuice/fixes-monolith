/**
 * Where background work (receive queue, outbox worker, transfers) reports problems it handled but
 * that a developer should still see. Injected so tests can capture output instead of printing it.
 * Messages and errors passed here never contain key material or message bodies.
 */
export interface Logger {
  warn(message: string, error?: unknown): void;
  error(message: string, error?: unknown): void;
}

export const consoleLogger: Logger = {
  warn(message, error) {
    if (error === undefined) console.warn(message);
    else console.warn(message, error);
  },
  error(message, error) {
    if (error === undefined) console.error(message);
    else console.error(message, error);
  },
};
