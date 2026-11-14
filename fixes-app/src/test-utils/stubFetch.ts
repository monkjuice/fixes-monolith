import type { FetchLike, HttpResponseLike } from '../core/platform';

export interface StubRequest {
  method: string;
  url: string;
  /** Path and query below the origin, e.g. `/v1/users?q=ab`. */
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface StubResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type StubHandler = (request: StubRequest) => StubResponse | Promise<StubResponse>;

export function json(status: number, body?: unknown, headers?: Record<string, string>): StubResponse {
  return { status, body, headers };
}

export function apiError(status: number, code: string, message = code, details: Record<string, unknown> = {}): StubResponse {
  return { status, body: { error: { code, message, details } } };
}

function toResponse(stub: StubResponse): HttpResponseLike {
  const headers = new Map(Object.entries(stub.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const text = stub.body === undefined ? '' : typeof stub.body === 'string' ? stub.body : JSON.stringify(stub.body);
  return {
    status: stub.status,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    text: async () => text,
  };
}

/**
 * A fetch stub driven by one handler. Every call is recorded in `calls`. A handler may throw to
 * simulate a network failure (the transport maps it to NetworkError).
 */
export function createStubFetch(handler: StubHandler): FetchLike & { calls: StubRequest[] } {
  const calls: StubRequest[] = [];
  const fetchFn = async (url: string, init: Parameters<FetchLike>[1]) => {
    const parsed = /^https?:\/\/[^/]+(\/.*)?$/.exec(url);
    const request: StubRequest = {
      method: init.method,
      url,
      path: parsed?.[1] ?? '/',
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(request);
    return toResponse(await handler(request));
  };
  return Object.assign(fetchFn, { calls });
}

/** Route table helper: `routes({'POST /v1/auth/login': handler})`; unknown routes return 404. */
export function routes(table: Record<string, StubHandler>): StubHandler {
  return (request) => {
    const pathOnly = request.path.split('?')[0];
    const handler = table[`${request.method} ${pathOnly}`];
    if (!handler) return apiError(404, 'not_found', `No stub for ${request.method} ${pathOnly}`);
    return handler(request);
  };
}
