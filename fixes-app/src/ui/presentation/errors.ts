import { ApiError, NetworkError, isSignedOutError, isTransientError, type ApiErrorCode } from '../../core/api/errors';
import { MessagingError } from '../../core/messaging/errors';
import { InputValidationError } from '../../core/utils/validation';

/** Legacy wording (LoginViewModel / RegisterViewModel), kept by §14. */
export const NO_INTERNET = 'No internet connection';
export const GENERIC_ERROR = 'Something went wrong. Please try again.';

export type ErrorMessages = Partial<Record<ApiErrorCode, string>>;

function formatWait(seconds: number): string {
  if (seconds < 60) return seconds === 1 ? '1 second' : `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/**
 * A user-facing sentence for an error from the core (API, validation, messaging). Screen-specific
 * texts for API codes come in `messages`. Unexpected errors are logged (they indicate a bug) and
 * shown generically; server messages are never shown verbatim.
 */
export function describeError(error: unknown, messages: ErrorMessages = {}): string {
  if (error instanceof NetworkError) return NO_INTERNET;
  if (error instanceof InputValidationError || error instanceof MessagingError) return error.message;
  if (error instanceof ApiError) {
    const specific = messages[error.code];
    if (specific) return specific;
    if (error.code === 'rate_limited') {
      return error.retryAfter !== null
        ? `Too many attempts. Try again in ${formatWait(error.retryAfter)}.`
        : 'Too many attempts. Please try again later.';
    }
    if (error.status >= 500) return 'The server is having trouble. Please try again later.';
    console.warn(`Unhandled API error: ${error.code} (${error.status})`);
    return GENERIC_ERROR;
  }
  console.error('Unexpected error', error);
  return GENERIC_ERROR;
}

/**
 * Background work started by a screen (peer refresh, mailbox sync, read marking): connectivity
 * problems, a session that just ended and an engine that is not running yet are expected and retried
 * by the next trigger, so they are not reported; anything else is logged.
 */
export function reportBackgroundError(context: string, error: unknown): void {
  if (isTransientError(error) || isSignedOutError(error)) return;
  if (error instanceof MessagingError && error.code === 'not_ready') return;
  console.warn(`${context} failed`, error);
}
