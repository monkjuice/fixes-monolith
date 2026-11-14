import { isSignedOutError } from '../api/errors';
import type { Envelope } from '../api/types';
import { parseEnvelope } from '../api/validate';
import { randomFloat } from '../crypto/random';
import { Emitter } from '../events';
import { WEBSOCKET_OPEN, type WebSocketFactory, type WebSocketLike } from '../platform';
import { backoffDelay } from './backoff';

/** WebSocket client for protocol §6. */

export type SocketStatus =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'ready'
  /** Waiting for the next reconnect attempt. */
  | 'backoff'
  /** Closed with 4409 by a newer socket of this device; stays down until resume(). */
  | 'replaced'
  | 'stopped';

export interface RealtimeEvents extends Record<string, unknown> {
  status: { status: SocketStatus };
  /** Server accepted the auth frame. The client must now drain `GET /v1/envelopes` (§13). */
  ready: { gap: boolean };
  envelope: { envelope: Envelope };
  devices_changed: undefined;
  /** A frame that breaks the contract; reported, never fatal. */
  protocolError: { message: string };
}

export interface SocketTokenSource {
  getAccessToken(): Promise<string>;
  refresh(staleToken: string | null): Promise<string>;
}

export interface RealtimeSocketOptions {
  url: string;
  factory: WebSocketFactory;
  tokens: SocketTokenSource;
  random?: () => number;
  pingIntervalMs?: number;
  /** Give up on a socket that has not reached `ready` after this long. */
  readyTimeoutMs?: number;
}

export const CLOSE_AUTH_FAILED = 4401;
export const CLOSE_AUTH_TIMEOUT = 4408;
export const CLOSE_REPLACED = 4409;
const CLOSE_CLIENT_GOING_AWAY = 1000;

type Timer = ReturnType<typeof setTimeout>;
type Interval = ReturnType<typeof setInterval>;

export class RealtimeSocket {
  readonly events = new Emitter<RealtimeEvents>();
  private state: SocketStatus = 'idle';
  private ws: WebSocketLike | null = null;
  // Identifies the current connection; callbacks from older sockets or stale async work compare against it.
  private connection = 0;
  private attempt = 0;
  private refreshedAfterAuthFailure = false;
  private reconnectTimer: Timer | null = null;
  private readyTimer: Timer | null = null;
  private pingTimer: Interval | null = null;
  private lastFrameAt = 0;
  private readonly random: () => number;
  private readonly pingIntervalMs: number;
  private readonly readyTimeoutMs: number;

  constructor(private readonly options: RealtimeSocketOptions) {
    this.random = options.random ?? randomFloat;
    this.pingIntervalMs = options.pingIntervalMs ?? 25_000;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 15_000;
  }

  get status(): SocketStatus {
    return this.state;
  }

  /** Starts connecting unless already running. Does not override a 4409 replacement (see resume()). */
  start(): void {
    if (this.state === 'idle' || this.state === 'stopped') {
      this.attempt = 0;
      void this.connect();
    }
  }

  /** App returned to the foreground: reconnect after a 4409, or skip a pending backoff wait. */
  resume(): void {
    if (this.state === 'replaced' || this.state === 'backoff' || this.state === 'idle' || this.state === 'stopped') {
      this.clearReconnect();
      this.attempt = 0;
      void this.connect();
    }
  }

  /** Closes the socket for good (logout, sign-out, app teardown). */
  stop(): void {
    this.connection++;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) this.detachAndClose(ws, CLOSE_CLIENT_GOING_AWAY, 'client stop');
    this.setStatus('stopped');
  }

  /** Acknowledges envelopes over the socket (same semantics as REST ack). Returns false when not ready. */
  sendAck(ids: string[]): boolean {
    if (this.state !== 'ready' || !this.ws || this.ws.readyState !== WEBSOCKET_OPEN || ids.length === 0) return false;
    this.ws.send(JSON.stringify({ type: 'ack', ids }));
    return true;
  }

  private async connect(): Promise<void> {
    const connection = ++this.connection;
    this.clearTimers();
    this.setStatus('connecting');
    let token: string;
    try {
      token = await this.options.tokens.getAccessToken();
    } catch (error) {
      if (connection !== this.connection) return;
      // Signed out: the TokenManager has already told the session layer, which will stop us.
      if (isSignedOutError(error)) {
        this.stop();
        return;
      }
      this.scheduleReconnect();
      return;
    }
    if (connection !== this.connection) return;
    let ws: WebSocketLike;
    try {
      ws = this.options.factory.create(this.options.url);
    } catch (error) {
      this.events.emit('protocolError', { message: `Could not open WebSocket: ${String(error)}` });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (connection !== this.connection) return;
      this.setStatus('authenticating');
      ws.send(JSON.stringify({ type: 'auth', token }));
      this.readyTimer = setTimeout(() => this.abandon(connection), this.readyTimeoutMs);
    };
    ws.onmessage = (event) => {
      if (connection !== this.connection) return;
      this.handleFrame(event.data);
    };
    ws.onerror = () => {
      // Errors are always followed by a close event, which drives reconnection.
    };
    ws.onclose = (event) => {
      if (connection !== this.connection) return;
      this.ws = null;
      this.clearTimers();
      void this.handleClose(event.code, connection);
    };
  }

  private handleFrame(data: unknown): void {
    this.lastFrameAt = Date.now();
    if (typeof data !== 'string') {
      this.events.emit('protocolError', { message: 'Non-text frame' });
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      this.events.emit('protocolError', { message: 'Frame is not JSON' });
      return;
    }
    if (typeof frame !== 'object' || frame === null) {
      this.events.emit('protocolError', { message: 'Frame is not an object' });
      return;
    }
    const f = frame as Record<string, unknown>;
    switch (f.type) {
      case 'ready':
        this.onReady(f.gap === true);
        break;
      case 'envelope':
        try {
          this.events.emit('envelope', { envelope: parseEnvelope(f.envelope) });
        } catch (error) {
          this.events.emit('protocolError', { message: error instanceof Error ? error.message : 'Bad envelope' });
        }
        break;
      case 'devices_changed':
        this.events.emit('devices_changed', undefined);
        break;
      case 'pong':
        break;
      default:
        // Unknown frame types are ignored for forward compatibility.
        break;
    }
  }

  private onReady(gap: boolean): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.attempt = 0;
    this.refreshedAfterAuthFailure = false;
    this.setStatus('ready');
    this.lastFrameAt = Date.now();
    const connection = this.connection;
    this.pingTimer = setInterval(() => this.ping(connection), this.pingIntervalMs);
    this.events.emit('ready', { gap });
  }

  private ping(connection: number): void {
    const ws = this.ws;
    if (connection !== this.connection || !ws) return;
    // No frame (not even a pong) for two ping periods: the connection is dead even if the OS has not noticed.
    if (Date.now() - this.lastFrameAt > this.pingIntervalMs * 2 + 5_000) {
      this.abandon(connection);
      return;
    }
    if (ws.readyState === WEBSOCKET_OPEN) ws.send(JSON.stringify({ type: 'ping' }));
  }

  private async handleClose(code: number, connection: number): Promise<void> {
    if (code === CLOSE_REPLACED) {
      this.setStatus('replaced');
      return;
    }
    if (code === CLOSE_AUTH_FAILED && !this.refreshedAfterAuthFailure) {
      this.refreshedAfterAuthFailure = true;
      try {
        // §6: one refresh with the server, never the newer token REST calls left in memory: that one
        // may be just as dead (revoked device), and only the refresh answer can sign the device out.
        await this.options.tokens.refresh(null);
      } catch (error) {
        if (connection !== this.connection) return;
        if (isSignedOutError(error)) {
          this.stop();
          return;
        }
        this.scheduleReconnect();
        return;
      }
      if (connection !== this.connection) return;
      void this.connect();
      return;
    }
    // 4408, a second 4401 in a row, and every other code: reconnect with backoff.
    this.scheduleReconnect();
  }

  /** Drops a connection that stopped answering and reconnects with backoff. */
  private abandon(connection: number): void {
    if (connection !== this.connection) return;
    const ws = this.ws;
    this.ws = null;
    this.connection++;
    this.clearTimers();
    if (ws) this.detachAndClose(ws, CLOSE_CLIENT_GOING_AWAY, 'unresponsive');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    const delay = backoffDelay(this.attempt, this.random);
    this.attempt++;
    this.setStatus('backoff');
    const connection = this.connection;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (connection === this.connection && this.state === 'backoff') void this.connect();
    }, delay);
  }

  private detachAndClose(ws: WebSocketLike, code: number, reason: string): void {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close(code, reason);
    } catch (error) {
      // Closing an already broken socket can throw; the socket is discarded either way.
      this.events.emit('protocolError', { message: `Error while closing socket: ${String(error)}` });
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearTimers(): void {
    this.clearReconnect();
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private setStatus(status: SocketStatus): void {
    if (this.state === status) return;
    this.state = status;
    this.events.emit('status', { status });
  }
}
