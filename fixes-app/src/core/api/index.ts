import type { Clock, FetchLike, HttpUpload } from '../platform';
import { systemClock } from '../platform';
import { ApiClient } from './client';
import { HttpTransport } from './http';
import { TokenManager, type RefreshTokenStore } from './tokens';

export * from './client';
export * from './errors';
export * from './http';
export * from './tokens';
export * from './types';
export {
  ResponseShapeError,
  staleDevicesDetails,
  tooManyDevicesDetails,
} from './validate';

export interface ApiStackOptions {
  apiBaseUrl: string;
  refreshTokens: RefreshTokenStore;
  /** Defaults to the global fetch (React Native and Node 20 both have one). */
  fetch?: FetchLike;
  upload?: HttpUpload | null;
  clock?: Clock;
  timeoutMs?: number;
}

/** Wires transport, token manager and client together; the token manager is shared with the socket. */
export function createApiStack(options: ApiStackOptions): { api: ApiClient; tokens: TokenManager; transport: HttpTransport } {
  // Wrapped rather than passed bare: some fetch implementations require `this === globalThis`.
  const fetchFn: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const transport = new HttpTransport(options.apiBaseUrl, fetchFn, options.upload ?? null, options.timeoutMs);
  const tokens = new TokenManager(transport, options.refreshTokens, options.clock ?? systemClock);
  return { api: new ApiClient(transport, tokens), tokens, transport };
}
