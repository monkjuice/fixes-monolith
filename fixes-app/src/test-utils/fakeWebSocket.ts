import { WEBSOCKET_OPEN, type WebSocketFactory, type WebSocketLike } from '../core/platform';

/** Scriptable WebSocket for unit tests: the test plays the server. */
export class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: string[] = [];
  closedByClient: { code?: number; reason?: string } | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    if (this.readyState !== WEBSOCKET_OPEN) throw new Error('send() on a socket that is not open');
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedByClient = { code, reason };
    this.readyState = 3;
  }

  /** Frames the client sent, parsed. */
  sentFrames(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }

  serverOpen(): void {
    this.readyState = WEBSOCKET_OPEN;
    this.onopen?.();
  }

  serverSend(frame: unknown): void {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }

  serverClose(code: number, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

export class FakeWebSocketFactory implements WebSocketFactory {
  readonly sockets: FakeWebSocket[] = [];

  create(url: string): FakeWebSocket {
    const ws = new FakeWebSocket(url);
    this.sockets.push(ws);
    return ws;
  }

  get last(): FakeWebSocket {
    const ws = this.sockets[this.sockets.length - 1];
    if (!ws) throw new Error('No socket was created');
    return ws;
  }
}
