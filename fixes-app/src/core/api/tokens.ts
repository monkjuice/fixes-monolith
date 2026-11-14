import { Emitter } from '../events';
import { systemClock, type Clock } from '../platform';
import { ApiError, isSignedOutError } from './errors';
import type { HttpTransport } from './http';
import type { Tokens } from './types';
import { parseTokens } from './validate';

/** Where the current refresh token lives (secure storage, `fixes.session`, protocol §12.1). */
export interface RefreshTokenStore {
  getRefreshToken(): Promise<string | null>;
  /** Must resolve only once the token is durably stored. */
  setRefreshToken(token: string): Promise<void>;
}

export type SignedOutReason = 'device_revoked' | 'invalid_refresh_token';

export interface TokenEvents extends Record<string, unknown> {
  /** The device can no longer authenticate (§6: "This device was signed out"). */
  signedOut: { reason: SignedOutReason };
  refreshed: undefined;
}

// Refresh slightly before expiry so a request does not race the token's last seconds.
const EXPIRY_MARGIN_MS = 30_000;

/**
 * Owns the in-memory access token and the single-flight refresh shared by the REST client and the
 * realtime socket. Refresh tokens are one-time use (protocol §5.2): two concurrent refreshes with the
 * same token would look like reuse to the server, so there is never more than one in flight.
 */
export class TokenManager {
  readonly events = new Emitter<TokenEvents>();
  private accessToken: string | null = null;
  private expiresAt = 0;
  private inflight: Promise<string> | null = null;
  // Bumped by clear(): a refresh that started before a logout must not resurrect the session.
  private generation = 0;

  constructor(
    private readonly transport: HttpTransport,
    private readonly store: RefreshTokenStore,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Installs tokens from login. The caller has already persisted `tokens.refresh_token`. */
  setTokens(tokens: Pick<Tokens, 'access_token' | 'expires_in'>): void {
    this.accessToken = tokens.access_token;
    this.expiresAt = this.clock.now() + tokens.expires_in * 1000;
  }

  /** Forgets the access token and invalidates any refresh still in flight. */
  clear(): void {
    this.generation++;
    this.accessToken = null;
    this.expiresAt = 0;
    this.inflight = null;
  }

  currentAccessToken(): string | null {
    return this.accessToken;
  }

  /** A usable access token, refreshing first when it is missing or about to expire. */
  async getAccessToken(): Promise<string> {
    if (this.accessToken && this.clock.now() < this.expiresAt - EXPIRY_MARGIN_MS) return this.accessToken;
    return this.refresh(this.accessToken);
  }

  /**
   * Single-flight refresh. `staleToken` is the access token the caller saw rejected: if another caller
   * already replaced it, the new token is returned without a second refresh.
   */
  refresh(staleToken: string | null = null): Promise<string> {
    if (this.inflight) return this.inflight;
    if (
      staleToken !== null &&
      this.accessToken !== null &&
      this.accessToken !== staleToken &&
      this.clock.now() < this.expiresAt - EXPIRY_MARGIN_MS
    ) {
      return Promise.resolve(this.accessToken);
    }
    const flight = this.doRefresh(this.generation).finally(() => {
      if (this.inflight === flight) this.inflight = null;
    });
    this.inflight = flight;
    return flight;
  }

  /** Called by the API client when any endpoint reports `device_revoked`. */
  signOut(reason: SignedOutReason): void {
    this.clear();
    this.events.emit('signedOut', { reason });
  }

  private async doRefresh(generation: number): Promise<string> {
    const refreshToken = await this.store.getRefreshToken();
    if (!refreshToken) {
      const error = new ApiError({ status: 401, code: 'invalid_refresh_token', message: 'No session on this device' });
      this.signOut('invalid_refresh_token');
      throw error;
    }
    let tokens: Tokens;
    try {
      tokens = await this.transport.requestJson(
        { method: 'POST', path: '/v1/auth/refresh', body: { refresh_token: refreshToken } },
        parseTokens,
      );
    } catch (error) {
      if (isSignedOutError(error) && generation === this.generation) {
        this.signOut(error.code as SignedOutReason);
      }
      throw error;
    }
    if (generation !== this.generation) {
      throw new ApiError({ status: 401, code: 'invalid_refresh_token', message: 'Signed out during refresh' });
    }
    // Persist first: if the app dies after this point the next launch still holds a valid token.
    // If persisting fails we must not use the new pair; the server's 60 s retry grace covers a retry.
    await this.store.setRefreshToken(tokens.refresh_token);
    if (generation !== this.generation) {
      throw new ApiError({ status: 401, code: 'invalid_refresh_token', message: 'Signed out during refresh' });
    }
    this.setTokens(tokens);
    this.events.emit('refreshed', undefined);
    return tokens.access_token;
  }
}
