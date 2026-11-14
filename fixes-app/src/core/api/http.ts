import type { FetchLike, HttpResponseLike, HttpUpload, UploadFile } from '../platform';
import { ApiError, isKnownApiErrorCode, NetworkError } from './errors';
import { ResponseShapeError } from './validate';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface JsonRequest {
  method: HttpMethod;
  /** Path below the base URL, starting with `/`. */
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  accessToken?: string;
  /** Deadline for the whole exchange, response body included; defaults to the transport's (30 s). */
  timeoutMs?: number;
}

export interface UploadRequest {
  method: 'PUT' | 'POST';
  path: string;
  field: string;
  file: UploadFile;
  accessToken: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;
/** For responses of several MB (a `GET /v1/envelopes` page holds up to about 4 MiB of ciphertext). */
export const LARGE_RESPONSE_TIMEOUT_MS = 120_000;

/**
 * One HTTP exchange: builds the request, applies a timeout, maps failures to NetworkError and
 * non-2xx answers to ApiError (protocol §5.1). Knows nothing about tokens or refresh.
 */
export class HttpTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: FetchLike,
    private readonly upload: HttpUpload | null,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  url(path: string, query?: Record<string, string | undefined>): string {
    const params = Object.entries(query ?? {})
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    return `${this.baseUrl}${path}${params.length > 0 ? `?${params.join('&')}` : ''}`;
  }

  /** Returns the parsed JSON body (undefined for 204), passed through `parse` for shape validation. */
  async requestJson<T>(req: JsonRequest, parse: (json: unknown) => T): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (req.body !== undefined) headers['Content-Type'] = 'application/json';
    if (req.accessToken) headers.Authorization = `Bearer ${req.accessToken}`;
    const { response, text } = await this.withTimeout(req.timeoutMs ?? this.timeoutMs, (signal) =>
      this.fetchFn(this.url(req.path, req.query), {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal,
      }),
    );
    return this.handleResponse(response, text, parse);
  }

  async uploadFile<T>(req: UploadRequest, parse: (json: unknown) => T): Promise<T> {
    const upload = this.upload;
    if (!upload) throw new Error('No HttpUpload implementation was provided');
    const { response, text } = await this.withTimeout(UPLOAD_TIMEOUT_MS, (signal) =>
      upload.send({
        url: this.url(req.path),
        method: req.method,
        headers: { Accept: 'application/json', Authorization: `Bearer ${req.accessToken}` },
        field: req.field,
        file: req.file,
        signal,
      }),
    );
    return this.handleResponse(response, text, parse);
  }

  /**
   * Sends the request and reads the whole body under one deadline. The global fetch on iOS/Android
   * (expo/fetch) resolves once the headers arrive and the native stacks set no read timeout, so a body
   * that stalls afterwards would otherwise never settle. At the deadline the request is aborted, and
   * the exchange fails even if the fetch implementation ignores the abort.
   */
  private async withTimeout(
    timeoutMs: number,
    run: (signal: AbortSignal) => Promise<HttpResponseLike>,
  ): Promise<{ response: HttpResponseLike; text: string }> {
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error('Deadline reached'));
      }, timeoutMs);
    });
    const timeout = (cause: unknown) => new NetworkError('timeout', 'The server did not answer in time', { cause });
    try {
      let response: HttpResponseLike;
      try {
        response = await Promise.race([run(controller.signal), deadline]);
      } catch (cause) {
        if (timedOut) throw timeout(cause);
        throw new NetworkError('offline', 'No internet connection', { cause });
      }
      try {
        return { response, text: await Promise.race([response.text(), deadline]) };
      } catch (cause) {
        if (timedOut) throw timeout(cause);
        throw new NetworkError('offline', 'The connection broke while reading the response', { cause });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private handleResponse<T>(response: HttpResponseLike, text: string, parse: (json: unknown) => T): T {
    if (response.status < 200 || response.status >= 300) {
      throw toApiError(response, text);
    }
    let json: unknown = undefined;
    if (response.status !== 204 && text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new ApiError({ status: response.status, code: 'invalid_response', message: 'The server sent invalid JSON' });
      }
    }
    try {
      return parse(json);
    } catch (error) {
      if (error instanceof ResponseShapeError) {
        throw new ApiError({ status: response.status, code: 'invalid_response', message: error.message });
      }
      throw error;
    }
  }
}

/** Retry-After is either delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, nowMs: number = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - nowMs) / 1000));
}

function toApiError(response: HttpResponseLike, text: string): ApiError {
  const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = null; // Not the §5.1 shape (e.g. a proxy page); handled as unknown_error below.
  }
  const error =
    typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  if (typeof error === 'object' && error !== null) {
    const e = error as { code?: unknown; message?: unknown; details?: unknown };
    const code = typeof e.code === 'string' && isKnownApiErrorCode(e.code) ? e.code : 'unknown_error';
    const details =
      typeof e.details === 'object' && e.details !== null && !Array.isArray(e.details)
        ? (e.details as Record<string, unknown>)
        : {};
    const message = typeof e.message === 'string' ? e.message.slice(0, 500) : `HTTP ${response.status}`;
    return new ApiError({ status: response.status, code, message, details, retryAfter });
  }
  return new ApiError({
    status: response.status,
    code: response.status === 429 ? 'rate_limited' : 'unknown_error',
    message: `HTTP ${response.status}`,
    retryAfter,
  });
}
