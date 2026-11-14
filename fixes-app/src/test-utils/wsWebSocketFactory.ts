import WebSocket from 'ws';

import type { WebSocketFactory, WebSocketLike } from '../core/platform';

/** WebSocketFactory backed by the `ws` package, for the e2e suite against a real server. */
export const wsWebSocketFactory: WebSocketFactory = {
  create(url: string): WebSocketLike {
    const ws = new WebSocket(url);
    const adapter: WebSocketLike = {
      get readyState() {
        return ws.readyState;
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: (data) => ws.send(data),
      close: (code, reason) => ws.close(code, reason),
    };
    ws.onopen = () => adapter.onopen?.();
    // ws delivers text frames as strings and binary frames as Buffers; the client rejects the latter.
    ws.onmessage = (event) => adapter.onmessage?.({ data: event.data });
    ws.onclose = (event) => adapter.onclose?.({ code: event.code, reason: event.reason });
    ws.onerror = (event) => adapter.onerror?.(event);
    return adapter;
  },
};
