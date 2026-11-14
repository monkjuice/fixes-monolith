import { CapturingLogger } from '../../../test-utils';
import { MemorySecureStore } from '../../../test-utils/memorySecureStore';
import { createApiStack } from '../../api';
import type { FetchLike } from '../../platform';
import { SecureItems, SessionRefreshTokenStore } from '../../session/secureItems';
import { ReceiveQueue } from '../receiveQueue';

afterEach(() => {
  jest.useRealTimers();
});

describe('ReceiveQueue', () => {
  it('fails a drain whose page body stalls, so the retry and a later drain (logout) still run', async () => {
    jest.useFakeTimers();
    let stall = true;
    // The first page's headers arrive, then the link dies without a reset: its body never ends.
    const fetch: FetchLike = async (_url, init) => {
      if (stall) {
        stall = false;
        const signal = init.signal!;
        return {
          status: 200,
          headers: { get: () => null },
          text: () => new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Request aborted')))),
        };
      }
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ envelopes: [], gap: false }) };
    };
    const { api, tokens } = createApiStack({
      apiBaseUrl: 'https://api.fixes.test',
      refreshTokens: new SessionRefreshTokenStore(new SecureItems(new MemorySecureStore())),
      fetch,
    });
    tokens.setTokens({ access_token: 'access-0', expires_in: 900 });
    const logger = new CapturingLogger();
    const syncing: boolean[] = [];
    const queue = new ReceiveQueue({
      api,
      processor: { process: async () => Promise.reject(new Error('The mailbox is empty')) },
      logger,
      random: () => 0.5,
      pageSize: 100,
      backoff: { minMs: 1_000, maxMs: 30_000 },
      onGap: () => undefined,
      onProcessed: () => undefined,
      onSyncing: (value) => syncing.push(value),
    });

    let settled: unknown = null;
    queue.drain().then(
      () => (settled = 'drained'),
      (error: unknown) => (settled = error),
    );
    await jest.advanceTimersByTimeAsync(120_000);
    expect(settled).toMatchObject({ kind: 'timeout' });
    expect(syncing).toEqual([true, false]);
    expect(logger.entries.map((e) => e.message)).toEqual(['Receiving paused after a network error; will retry']);

    // The drain logout runs (§13) is not stuck behind the stalled one.
    await expect(queue.drain()).resolves.toBeUndefined();
    queue.stop();
  });
});
