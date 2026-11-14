import { WEBSOCKET_OPEN, type WebSocketFactory, type WebSocketLike } from '../../core/platform';

/** What a FakeServerSocket needs from the server. */
export interface RealtimeHost {
  readonly offline: boolean;
  onSocketOpen(socket: FakeServerSocket): void;
  onSocketFrame(socket: FakeServerSocket, data: string): void;
  onSocketClosed(socket: FakeServerSocket): void;
}

/** Network delivery is asynchronous in reality; tests must not depend on synchronous callbacks. */
function later(fn: () => void): void {
  setTimeout(fn, 0);
}

/**
 * Client-facing WebSocket connected to the in-memory server (protocol §6). The client end behaves like
 * the WHATWG WebSocket the app uses; the server end is driven by FakeFixesServer.
 */
export class FakeServerSocket implements WebSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  /** Set once the auth frame was accepted. */
  deviceId: string | null = null;
  readonly received: Record<string, unknown>[] = [];

  constructor(
    private readonly host: RealtimeHost,
    readonly url: string,
  ) {
    later(() => {
      if (this.readyState !== 0) return;
      if (host.offline) {
        this.closeFromServer(1006, 'unreachable');
        return;
      }
      this.readyState = WEBSOCKET_OPEN;
      host.onSocketOpen(this);
      this.onopen?.();
    });
  }

  // ---- client end ----

  send(data: string): void {
    if (this.readyState !== WEBSOCKET_OPEN) throw new Error('send() on a socket that is not open');
    later(() => {
      if (this.readyState === WEBSOCKET_OPEN) this.host.onSocketFrame(this, data);
    });
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.host.onSocketClosed(this);
    later(() => this.onclose?.({ code, reason }));
  }

  // ---- server end ----

  serverSend(frame: Record<string, unknown>): void {
    if (this.readyState !== WEBSOCKET_OPEN) return;
    this.received.push(frame);
    const data = JSON.stringify(frame);
    later(() => {
      if (this.readyState === WEBSOCKET_OPEN) this.onmessage?.({ data });
    });
  }

  closeFromServer(code: number, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.host.onSocketClosed(this);
    later(() => this.onclose?.({ code, reason }));
  }
}

export function createSocketFactory(host: RealtimeHost, sockets: FakeServerSocket[]): WebSocketFactory {
  return {
    create(url: string): WebSocketLike {
      const socket = new FakeServerSocket(host, url);
      sockets.push(socket);
      return socket;
    },
  };
}
