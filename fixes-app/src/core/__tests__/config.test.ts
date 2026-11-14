import { ConfigError, resolveApiConfig } from '../config';

describe('resolveApiConfig (§3)', () => {
  it('derives the WebSocket URL from the API base URL', () => {
    expect(resolveApiConfig('https://fixes.example.com', { release: true })).toEqual({
      apiBaseUrl: 'https://fixes.example.com',
      wsUrl: 'wss://fixes.example.com/v1/ws',
    });
    expect(resolveApiConfig('https://example.com:8443/fixes/', { release: true })).toEqual({
      apiBaseUrl: 'https://example.com:8443/fixes',
      wsUrl: 'wss://example.com:8443/fixes/v1/ws',
    });
  });

  it('allows cleartext only in development builds', () => {
    expect(resolveApiConfig('http://10.0.2.2:8000', { release: false })).toEqual({
      apiBaseUrl: 'http://10.0.2.2:8000',
      wsUrl: 'ws://10.0.2.2:8000/v1/ws',
    });
    expect(() => resolveApiConfig('http://10.0.2.2:8000', { release: true })).toThrow(ConfigError);
  });

  it.each([undefined, '', '   ', 'fixes.example.com', 'ftp://x', 'https://x/?q=1', 'https://user:pw@x', 'https://x/#frag'])(
    'rejects %p',
    (raw) => {
      expect(() => resolveApiConfig(raw, { release: false })).toThrow(ConfigError);
    },
  );
});
