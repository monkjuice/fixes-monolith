/**
 * Resolved server endpoints. The raw URL is read from the environment only in src/platform/config.ts
 * (or by tests) and passed in; core never reads process.env.
 */
export interface ApiConfig {
  /** Server origin (plus optional path prefix) without trailing slash, e.g. `https://fixes.example.com`. */
  apiBaseUrl: string;
  /** WebSocket endpoint derived from the base URL: `wss://…/v1/ws`. */
  wsUrl: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// RN's URL implementation is incomplete, so the URL is checked with a deliberately narrow pattern:
// scheme, host[:port] and an optional path; no credentials, query or fragment.
const URL_PATTERN = /^(https?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:\d{1,5})?(\/[A-Za-z0-9._~\-/]*)?$/;

/**
 * Validates the API base URL. Release builds refuse anything but https (protocol §3); development
 * builds also accept http so a local server can be used.
 */
export function resolveApiConfig(rawUrl: string | undefined | null, options: { release: boolean }): ApiConfig {
  const trimmed = (rawUrl ?? '').trim();
  if (trimmed.length === 0) {
    throw new ConfigError('The API URL is not configured (set EXPO_PUBLIC_API_URL).');
  }
  const match = URL_PATTERN.exec(trimmed);
  if (!match) {
    throw new ConfigError('The API URL must look like https://host[:port][/path] without query or fragment.');
  }
  const scheme = match[1].toLowerCase();
  if (options.release && scheme !== 'https') {
    throw new ConfigError('Release builds only talk to the server over https.');
  }
  const apiBaseUrl = trimmed.replace(/\/+$/, '');
  const wsUrl = `${scheme === 'https' ? 'wss' : 'ws'}${apiBaseUrl.slice(scheme.length)}/v1/ws`;
  return { apiBaseUrl, wsUrl };
}
