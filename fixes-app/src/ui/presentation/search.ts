import { isValidSearchQuery } from '../../core/utils/validation';

/** Shown instead of calling the server: `GET /v1/users?q=` only accepts this format (§5.3, §14). */
export const SEARCH_RULE = 'Search with 1 to 30 letters, digits or underscores.';

export type SearchInput = { ok: true; query: string } | { ok: false; error: string };

/**
 * Discover input check (§14): surrounding whitespace is ignored (keyboards add it), anything else
 * outside `[A-Za-z0-9_]{1,30}` is refused locally so the server never sees an invalid query.
 */
export function validateSearchInput(text: string): SearchInput {
  const query = text.trim();
  return isValidSearchQuery(query) ? { ok: true, query } : { ok: false, error: SEARCH_RULE };
}
