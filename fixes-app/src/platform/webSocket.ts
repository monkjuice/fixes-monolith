import type { WebSocketFactory, WebSocketLike } from '../core/platform';

/** WebSocketFactory over React Native's global WebSocket. */
export const nativeWebSocketFactory: WebSocketFactory = {
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
    ws.onmessage = (event) => adapter.onmessage?.({ data: event.data });
    ws.onclose = (event) => adapter.onclose?.({ code: event.code, reason: event.reason });
    ws.onerror = (event) => adapter.onerror?.(event);
    return adapter;
  },
};
