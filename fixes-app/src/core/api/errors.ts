/** Error codes from protocol §5.1 plus two client-side codes. */
export type ApiErrorCode =
  | 'validation_error'
  | 'unauthorized'
  | 'invalid_credentials'
  | 'invalid_refresh_token'
  | 'device_revoked'
  | 'forbidden'
  | 'not_friends'
  | 'device_not_linked'
  | 'not_found'
  | 'username_taken'
  | 'already_friends'
  | 'request_exists'
  | 'identity_exists'
  | 'device_key_in_use'
  | 'too_many_devices'
  | 'stale_devices'
  | 'cannot_friend_self'
  | 'invalid_image'
  | 'invalid_public_key'
  | 'invalid_certificate'
  | 'payload_too_large'
  | 'rate_limited'
  | 'internal_error'
  /** Client-side: the server answered with a body that does not match the contract. */
  | 'invalid_response'
  /** Client-side: a non-2xx answer without the §5.1 error body (e.g. from a proxy). */
  | 'unknown_error';

const KNOWN_CODES: ReadonlySet<string> = new Set<ApiErrorCode>([
  'validation_error',
  'unauthorized',
  'invalid_credentials',
  'invalid_refresh_token',
  'device_revoked',
  'forbidden',
  'not_friends',
  'device_not_linked',
  'not_found',
  'username_taken',
  'already_friends',
  'request_exists',
  'identity_exists',
  'device_key_in_use',
  'too_many_devices',
  'stale_devices',
  'cannot_friend_self',
  'invalid_image',
  'invalid_public_key',
  'invalid_certificate',
  'payload_too_large',
  'rate_limited',
  'internal_error',
]);

export function isKnownApiErrorCode(code: string): code is ApiErrorCode {
  return KNOWN_CODES.has(code);
}

/** A non-2xx response from the server (or a 2xx response that breaks the contract). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: Record<string, unknown>;
  /** Seconds from the Retry-After header (429), otherwise null. */
  readonly retryAfter: number | null;

  constructor(params: {
    status: number;
    code: ApiErrorCode;
    message: string;
    details?: Record<string, unknown>;
    retryAfter?: number | null;
  }) {
    super(params.message);
    this.name = 'ApiError';
    this.status = params.status;
    this.code = params.code;
    this.details = params.details ?? {};
    this.retryAfter = params.retryAfter ?? null;
  }
}

/** The request never produced an HTTP response (offline, DNS, TLS, timeout). Safe to retry. */
export class NetworkError extends Error {
  readonly kind: 'offline' | 'timeout';

  constructor(kind: 'offline' | 'timeout', message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NetworkError';
    this.kind = kind;
  }
}

/** The refresh token or the device is gone for good: the app must enter the signed-out state. */
export function isSignedOutError(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.code === 'device_revoked' || error.code === 'invalid_refresh_token');
}

/** Network failures and 5xx answers are transient; everything else is a definitive answer. */
export function isTransientError(error: unknown): boolean {
  return error instanceof NetworkError || (error instanceof ApiError && error.status >= 500);
}
