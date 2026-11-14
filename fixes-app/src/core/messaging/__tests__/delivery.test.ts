import { apiError, randomTestPassword, waitFor, waitForQuiet, type StubResponse } from '../../../test-utils';
import { handleRest } from '../../../test-utils/fakeServer/rest';
import { toBase64 } from '../../crypto/encoding';
import { randomBytes, uuidv4 } from '../../crypto/random';
import type { MessageRow } from '../../db/types';
import { addLinkedDevice, createWorld, disposePhones, messageOn, messagesOf, noErrors, statusOn } from './world';

// Integration tests run several phones on real timers; leave room for slow machines.
jest.setTimeout(20_000);

afterEach(async () => {
  await disposePhones();
});

describe('receive queue', () => {
  it('applies duplicate envelopes once (one row, one unread, one delivered receipt)', async () => {
    const w = await createWorld();
    w.bob2.engine.detach();
    const sent = await w.alice1.engine.sendMessage(w.bobId, 'only once');
    await waitFor(() => w.server.pendingFor(w.bob2.deviceId).length === 1);
    const original = w.server.pendingFor(w.bob2.deviceId)[0];
    // The same ciphertext again under a new envelope id (a replaying server or a resend).
    w.server.injectEnvelope({
      recipientDeviceId: original.recipientDeviceId,
      senderUserId: original.senderUserId,
      senderDeviceId: original.senderDeviceId,
      nonce: original.nonce,
      ciphertext: original.ciphertext,
      createdAt: original.createdAt,
    });
    await waitForQuiet(w.server);
    const postsBefore = w.server.posts.length;

    w.bob2.engine.attach();
    await waitFor(() => w.server.pendingFor(w.bob2.deviceId).length === 0, { message: 'mailbox acked' });
    await waitForQuiet(w.server);
    expect((await messagesOf(w.bob2, w.aliceId)).map((m) => m.id)).toEqual([sent.id]);
    expect((await w.bob2.store.conversations.get(w.aliceId))?.unread_count).toBe(1);
    // Exactly one delivered receipt for the one inserted row, despite the duplicate.
    const fromBob2 = w.server.posts.slice(postsBefore).filter((p) => p.senderDeviceId === w.bob2.deviceId);
    expect(fromBob2).toHaveLength(1);
    noErrors(w);
  });

  it('a receipt that arrives before its message is kept as a hint and applied later', async () => {
    const w = await createWorld();
    // The sync copy to alice2 is delayed; Bob's delivered receipt overtakes it.
    w.server.holdFilter = (e) => e.recipientDeviceId === w.alice2.deviceId && e.senderDeviceId === w.alice1.deviceId;
    const sent = await w.alice1.engine.sendMessage(w.bobId, 'overtaken');
    await waitFor(async () => (await statusOn(w.alice1, sent.id)) === 'delivered');
    await waitFor(async () => (await w.alice2.store.receiptHints.listAll()).some((h) => h.message_id === sent.id));
    expect(await messageOn(w.alice2, sent.id)).toBeNull();
    w.server.releaseHeld();
    await waitFor(async () => (await statusOn(w.alice2, sent.id)) === 'delivered', { message: 'hint applied' });
    expect(await w.alice2.store.receiptHints.listAll()).toEqual([]);

    // Read sync that overtakes the message itself on bob2.
    w.server.holdFilter = (e) => e.recipientDeviceId === w.bob2.deviceId && e.senderUserId === w.aliceId;
    const second = await w.alice1.engine.sendMessage(w.bobId, 'read elsewhere');
    await waitFor(async () => (await messageOn(w.bob1, second.id)) !== null);
    await w.bob1.engine.markConversationRead(w.aliceId);
    await waitFor(async () =>
      (await w.bob2.store.receiptHints.listAll()).some((h) => h.message_id === second.id && h.status === 'read_sync'),
    );
    w.server.releaseHeld();
    await waitFor(async () => (await statusOn(w.bob2, second.id)) === 'read', { message: 'read sync hint applied' });
    expect((await w.bob2.store.conversations.get(w.aliceId))?.unread_count).toBe(0);
    noErrors(w);
  });

  it('a transient error while resolving keys stops the queue without acking, then retries', async () => {
    const w = await createWorld({ secondDevices: false });
    let failures = 0;
    w.server.interceptor = (request) => {
      const device = w.server.deviceOfRequest(request);
      if (device?.id === w.bob1.deviceId && request.path.startsWith(`/v1/users/${w.aliceId}/devices`) && failures < 3) {
        failures++;
        return apiError(503, 'internal_error');
      }
      return undefined;
    };
    const sent = await w.alice1.engine.sendMessage(w.bobId, 'try again');
    await waitFor(() => failures >= 1);
    expect(w.server.pendingFor(w.bob1.deviceId)).toHaveLength(1);
    expect(await messageOn(w.bob1, sent.id)).toBeNull();
    await waitFor(async () => (await messageOn(w.bob1, sent.id)) !== null, { message: 'applied after retry' });
    expect(failures).toBe(3);
    // Nothing was acked while failing: the first ack from bob1 comes after the successful apply.
    const bobAcks = w.server.log.filter((l) => l.deviceId === w.bob1.deviceId && l.path === '/v1/envelopes/ack');
    expect(bobAcks.length).toBeGreaterThanOrEqual(1);
    await waitFor(() => w.server.pendingFor(w.bob1.deviceId).length === 0);
    expect(w.bob1.logger.entries.some((e) => e.level === 'warn' && /network error/.test(e.message))).toBe(true);
    noErrors(w);
  });

  it.each<[string, () => StubResponse]>([
    ['a 429 (Retry-After)', () => ({ ...apiError(429, 'rate_limited'), headers: { 'Retry-After': '1' } })],
    ['a proxy 408 without the error body', () => ({ status: 408, body: '<html>Request Timeout</html>' })],
    ['a 200 that is not JSON (captive portal)', () => ({ status: 200, body: '<html>Sign in to the Wi-Fi</html>' })],
  ])('keeps the envelope when the sender lookup gets %s, and applies it on retry', async (_label, answer) => {
    const w = await createWorld({ secondDevices: false });
    let hits = 0;
    w.server.interceptor = (request) => {
      const device = w.server.deviceOfRequest(request);
      if (device?.id === w.bob1.deviceId && request.path.startsWith(`/v1/users/${w.aliceId}/devices`) && hits === 0) {
        hits++;
        return answer();
      }
      return undefined;
    };
    const sent = await w.alice1.engine.sendMessage(w.bobId, 'not a reason to drop me');
    await waitFor(() => hits === 1);
    // Such answers say nothing about the sender (§13: neither permanent nor an ineligible device).
    await waitFor(async () => (await messageOn(w.bob1, sent.id)) !== null, { message: 'applied after retry', timeoutMs: 5000 });
    expect(await messageOn(w.bob1, sent.id)).toMatchObject({ direction: 'in', body: 'not a reason to drop me' });
    await waitFor(() => w.server.pendingFor(w.bob1.deviceId).length === 0);
  });

  it('keeps the envelope when the token refresh during the sender lookup is rate limited', async () => {
    const w = await createWorld({ secondDevices: false });
    let refreshes = 0;
    w.server.interceptor = (request) => {
      if (request.method === 'POST' && request.path === '/v1/auth/refresh' && ++refreshes === 1) {
        return { ...apiError(429, 'rate_limited'), headers: { 'Retry-After': '1' } };
      }
      return undefined;
    };
    // bob1's access token expired on the server (as after 15 minutes); its socket stays connected.
    for (const [token, deviceId] of [...w.server.accessTokens]) {
      if (deviceId === w.bob1.deviceId) w.server.accessTokens.delete(token);
    }
    const sent = await w.alice1.engine.sendMessage(w.bobId, 'after the refresh');
    await waitFor(async () => (await messageOn(w.bob1, sent.id)) !== null, { message: 'applied after retry', timeoutMs: 5000 });
    expect(refreshes).toBeGreaterThanOrEqual(2);
    expect(w.bob1.logger.entries.some((e) => e.level === 'warn' && /rate limit/.test(e.message))).toBe(true);
    noErrors(w);
  });

  it('counts undecryptable envelopes once when their unacked page comes back after a restart', async () => {
    const w = await createWorld({ secondDevices: false });
    await w.alice1.engine.ensureConversation({ id: w.bobId, username: 'bob', avatar_url: null });
    const notices = async () =>
      (await messagesOf(w.alice1, w.bobId)).filter((m) => m.direction === 'system').map((m) => m.body);
    const junk = () =>
      w.server.injectEnvelope({
        recipientDeviceId: w.alice1.deviceId,
        senderUserId: w.bobId,
        senderDeviceId: w.bob1.deviceId,
        nonce: toBase64(randomBytes(24)),
        ciphertext: toBase64(randomBytes(300)),
      });
    w.alice1.engine.detach();
    for (let i = 0; i < 3; i++) junk();
    // The page is applied, but every ack is lost: the envelopes stay in the mailbox.
    let lostAcks = 0;
    w.server.interceptor = (request) => {
      if (request.method !== 'POST' || request.path !== '/v1/envelopes/ack') return undefined;
      lostAcks++;
      return apiError(503, 'internal_error');
    };
    w.alice1.engine.attach();
    await waitFor(() => lostAcks >= 2, { message: 'acks failed and were retried' });
    expect(await notices()).toEqual(['3 messages from bob could not be decrypted']);
    expect(w.server.pendingFor(w.alice1.deviceId)).toHaveLength(3);

    // The app restarts (a new runtime, nothing remembered in memory) and drains the same envelopes.
    w.alice1.engine.detach();
    w.server.interceptor = null;
    w.alice1.engine.attach();
    await waitFor(() => w.server.pendingFor(w.alice1.deviceId).length === 0, { message: 'acked after the restart' });
    expect(await notices()).toEqual(['3 messages from bob could not be decrypted']);

    // The run itself survived the restart: the next failure is counted in the same notice.
    junk();
    await waitFor(async () => (await notices())[0] === '4 messages from bob could not be decrypted', {
      message: 'fourth failure counted',
    });
    expect(await notices()).toHaveLength(1);
    expect((await w.alice1.store.conversations.get(w.bobId))?.unread_count).toBe(0);
    noErrors(w);
  });

  it('reports a gap when the mailbox overflowed', async () => {
    const w = await createWorld({ secondDevices: false });
    w.server.mailboxCaps.perSender = 2;
    w.bob1.engine.detach();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await w.alice1.engine.sendMessage(w.bobId, `n${i}`)).id);
    // A dropped copy does not fail the send: the recipient learns about the gap instead.
    await waitFor(async () => (await statusOn(w.alice1, ids[2])) === 'sent');
    expect(w.bob1.engine.getState().gap).toBe(false);
    w.bob1.engine.attach();
    await waitFor(() => w.bob1.engine.getState().gap, { message: 'gap reported' });
    await waitFor(async () => (await messagesOf(w.bob1, w.aliceId)).length === 2);
    w.bob1.engine.dismissGap();
    expect(w.bob1.engine.getState().gap).toBe(false);
    noErrors(w);
  });
});

describe('outbox', () => {
  it('marks a message to a non-friend as failed and empties the outbox', async () => {
    const w = await createWorld({ secondDevices: false });
    const carol = w.server.addUser('carol', randomTestPassword());
    const sent = await w.alice1.engine.sendMessage(carol.id, 'hi stranger');
    await waitFor(async () => (await statusOn(w.alice1, sent.id)) === 'failed');
    expect(await w.alice1.store.outbox.count()).toBe(0);
    noErrors(w);
  });

  it('retries once with fresh lists on stale_devices (revoked device in the cache)', async () => {
    const w = await createWorld();
    const first = await w.alice1.engine.sendMessage(w.bobId, 'warm the cache');
    await waitFor(async () => (await statusOn(w.alice1, first.id)) === 'delivered');
    const bob2Device = w.bob2.deviceId;
    w.server.revoke(bob2Device);
    const second = await w.alice1.engine.sendMessage(w.bobId, 'after revocation');
    await waitFor(async () => (await statusOn(w.alice1, second.id)) !== 'pending');
    expect(await statusOn(w.alice1, second.id)).not.toBe('failed');
    await waitFor(async () => (await messageOn(w.bob1, second.id)) !== null);
    const stale = w.server.log.filter((l) => l.deviceId === w.alice1.deviceId && l.code === 'stale_devices');
    expect(stale).toHaveLength(1);
    const last = w.server.posts.filter((p) => p.senderDeviceId === w.alice1.deviceId).at(-1)!;
    expect(last.recipientDeviceIds).not.toContain(bob2Device);
  });

  it('retries with fresh lists when the server reports missing devices (completeness)', async () => {
    const w = await createWorld({ secondDevices: false });
    const first = await w.alice1.engine.sendMessage(w.bobId, 'before bob2');
    await waitFor(async () => (await statusOn(w.alice1, first.id)) === 'delivered');
    const bob2 = await addLinkedDevice(w.bob1, 'bob2', 'bob', w.password);
    const second = await w.alice1.engine.sendMessage(w.bobId, 'after bob2');
    await waitFor(async () => (await messageOn(bob2, second.id)) !== null, { message: 'bob2 received' });
    expect(await messageOn(bob2, first.id)).toBeNull();
    const conflicts = w.server.log.filter((l) => l.deviceId === w.alice1.deviceId && l.code === 'stale_devices');
    expect(conflicts).toHaveLength(1);
    noErrors({ phones: [...w.phones, bob2] });
  });

  it('waits for Retry-After on rate_limited and keeps the message pending meanwhile', async () => {
    const w = await createWorld({ secondDevices: false });
    let limited = 0;
    w.server.interceptor = (request) => {
      if (request.path === '/v1/envelopes' && request.method === 'POST' && limited === 0) {
        limited++;
        return { ...apiError(429, 'rate_limited'), headers: { 'Retry-After': '1' } };
      }
      return undefined;
    };
    const sent = await w.alice1.engine.sendMessage(w.bobId, 'slow down');
    await waitFor(() => limited === 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await statusOn(w.alice1, sent.id)).toBe('pending');
    await waitFor(async () => (await statusOn(w.alice1, sent.id)) !== 'pending', { timeoutMs: 4000 });
    expect(['sent', 'delivered']).toContain(await statusOn(w.alice1, sent.id));
  });

  it('retries a failed message on request', async () => {
    const w = await createWorld({ secondDevices: false });
    w.server.unfriend(w.aliceId, w.bobId);
    const sent = await w.alice1.engine.sendMessage(w.bobId, 'again');
    await waitFor(async () => (await statusOn(w.alice1, sent.id)) === 'failed');
    w.server.makeFriends(w.aliceId, w.bobId);
    expect(await w.alice1.engine.retryMessage(sent.id)).toBe(true);
    await waitFor(async () => (await messageOn(w.bob1, sent.id)) !== null);
    expect(await w.alice1.engine.retryMessage(sent.id)).toBe(false);
  });

  it('validates input before storing anything', async () => {
    const w = await createWorld({ secondDevices: false });
    await expect(w.alice1.engine.sendMessage(w.bobId, '')).rejects.toMatchObject({ code: 'invalid_body' });
    await expect(w.alice1.engine.sendMessage(w.bobId, 'x'.repeat(4001))).rejects.toMatchObject({ code: 'invalid_body' });
    await expect(w.alice1.engine.sendMessage(w.aliceId, 'me')).rejects.toMatchObject({ code: 'invalid_peer' });
    await expect(w.alice1.engine.sendMessage('not-a-uuid', 'x')).rejects.toMatchObject({ code: 'invalid_peer' });
    expect(await w.alice1.store.outbox.count()).toBe(0);
    // 4000 characters (emoji count as one) is the maximum.
    await w.alice1.engine.sendMessage(w.bobId, '😀'.repeat(4000));
  });

  it('logout drains the mailbox and flushes the outbox before revoking the device', async () => {
    const w = await createWorld({ secondDevices: false });
    // Bob's socket is down, so Alice's message waits in his mailbox (no push).
    w.server.dropSocket(w.bob1.deviceId);
    await waitFor(() => w.bob1.engine.getState().connection !== 'ready');
    const sent = await w.alice1.engine.sendMessage(w.bobId, 'before you go');
    await waitFor(async () => (await statusOn(w.alice1, sent.id)) === 'sent');
    const bobDevice = w.bob1.deviceId;
    expect(w.server.pendingFor(bobDevice)).toHaveLength(1);

    expect(await w.bob1.engine.logout()).toEqual({ status: 'loggedOut' });
    expect(w.bob1.session.getState().status).toBe('signedOut');
    const bobLog = w.server.log.filter((l) => l.deviceId === bobDevice).map((l) => `${l.method} ${l.path}`);
    const logoutAt = bobLog.lastIndexOf('POST /v1/auth/logout');
    // Drained and acked, and the delivered receipt flushed, before the server logout.
    expect(bobLog.slice(0, logoutAt)).toEqual(
      expect.arrayContaining(['GET /v1/envelopes', 'POST /v1/envelopes/ack', 'POST /v1/envelopes']),
    );
    await waitFor(async () => (await statusOn(w.alice1, sent.id)) === 'delivered');
  });

  it('logout warns when items remain after the flush, and proceeds when forced', async () => {
    const w = await createWorld({ secondDevices: false });
    w.server.interceptor = (request) =>
      request.method === 'POST' && request.path === '/v1/envelopes'
        ? { ...apiError(429, 'rate_limited'), headers: { 'Retry-After': '60' } }
        : undefined;
    const sent = await w.alice1.engine.sendMessage(w.bobId, 'not yet');
    await waitFor(async () => (await w.alice1.store.outbox.listAll()).some((r) => r.attempts > 0));
    expect(await w.alice1.engine.logout()).toEqual({ status: 'unsent', remaining: 1 });
    expect(w.alice1.session.getState().status).toBe('ready');
    expect(await statusOn(w.alice1, sent.id)).toBe('pending');
    expect(await w.alice1.engine.logout({ force: true })).toEqual({ status: 'loggedOut' });
    expect(w.alice1.session.getState().status).toBe('signedOut');
  });

  it('logout while messaging is not running (startup error) warns before the mailbox is lost', async () => {
    const w = await createWorld({ secondDevices: false });
    const bobDevice = w.bob1.deviceId;
    // Retry on the startup error screen fails with a non-transient answer: loading + error, no runtime.
    w.server.interceptor = (request) =>
      request.method === 'GET' && request.path === '/v1/users/me' && w.server.deviceOfRequest(request)?.id === bobDevice
        ? apiError(400, 'validation_error')
        : undefined;
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await w.bob1.session.retry();
    } finally {
      error.mockRestore();
    }
    expect(w.bob1.session.getState()).toMatchObject({ status: 'loading', error: expect.any(String) });
    expect(w.bob1.engine.getState().status).toBe('stopped');
    await w.alice1.engine.sendMessage(w.bobId, 'waiting in your mailbox');
    await waitFor(() => w.server.pendingFor(bobDevice).length === 1);

    // §13: the mailbox cannot be drained, so the user is asked first; the server is not told yet.
    expect(await w.bob1.engine.logout()).toEqual({ status: 'undrained' });
    expect(w.server.log.filter((l) => l.deviceId === bobDevice && l.path === '/v1/auth/logout')).toEqual([]);
    expect(w.server.pendingFor(bobDevice)).toHaveLength(1);
    expect(w.bob1.session.getState().status).toBe('loading');

    // Confirmed: logs out anyway.
    expect(await w.bob1.engine.logout({ force: true })).toEqual({ status: 'loggedOut' });
    expect(w.bob1.session.getState().status).toBe('signedOut');
  });

  it('never POSTs a message again when storing its sent state fails (e.g. a full disk)', async () => {
    const w = await createWorld({ secondDevices: false });
    w.bob1.engine.detach(); // Bob is offline: every copy would pile up in his mailbox.
    const store = w.alice1.store;
    await w.alice1.engine.ensureConversation({ id: w.bobId, username: 'bob', avatar_url: null });
    // Queued directly, so the worker first runs once the disk is full.
    const now = Date.now();
    const row: MessageRow = {
      id: uuidv4(),
      peer_user_id: w.bobId,
      direction: 'out',
      sender_user_id: w.aliceId,
      body: 'hello',
      sent_at: now,
      server_ts: null,
      sort_ts: now,
      received_at: null,
      status: 'pending',
    };
    await store.transaction(async (tx) => {
      await tx.messages.insertOrIgnore(row);
      await tx.outbox.enqueueMessage(row.id, now);
    });
    // From now on writes fail, as with SQLITE_FULL; reads keep working.
    const full = () => Promise.reject(new Error('database or disk is full'));
    const writable = { transaction: store.transaction, reschedule: store.outbox.reschedule, delete: store.outbox.delete };
    Object.assign(store, { transaction: full });
    Object.assign(store.outbox, { reschedule: full, delete: full });
    const postsBefore = w.server.posts.length;
    w.alice1.engine.onForeground();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(w.server.posts.length - postsBefore).toBe(1);
    expect(w.server.pendingFor(w.bob1.deviceId)).toHaveLength(1);
    expect(await statusOn(w.alice1, row.id)).toBe('pending');

    // The disk has room again: the next attempt only stores the sent state.
    Object.assign(store, { transaction: writable.transaction });
    Object.assign(store.outbox, { reschedule: writable.reschedule, delete: writable.delete });
    w.alice1.engine.onForeground();
    await waitFor(async () => (await statusOn(w.alice1, row.id)) === 'sent', { message: 'sent', timeoutMs: 5000 });
    expect(w.server.posts.length - postsBefore).toBe(1);
    expect(await store.outbox.count()).toBe(0);
  });

  it('completes a send whose POST answer was lost even when a receipt overtook the retry', async () => {
    const w = await createWorld({ secondDevices: false, timings: { outboxBackoff: { minMs: 1500, maxMs: 1500 } } });
    w.alice1.clock.advance(10 * 60_000); // Alice's phone runs 10 minutes fast.
    let lose = true;
    w.server.interceptor = (request) => {
      if (lose && request.method === 'POST' && request.path === '/v1/envelopes' && w.server.deviceOfRequest(request)?.id === w.alice1.deviceId) {
        lose = false;
        handleRest(w.server, request); // stored and delivered, but the answer never arrives
        throw new TypeError('Network request failed');
      }
      return undefined;
    };
    const first = await w.alice1.engine.sendMessage(w.bobId, 'first');
    // Bob's delivered receipt arrives before the retry (1.5 s later).
    await waitFor(async () => (await statusOn(w.alice1, first.id)) === 'delivered', { message: 'delivered via receipt' });
    // The retry still runs: the server time replaces the local (fast) clock as the sort key (§7.1).
    await waitFor(async () => (await messageOn(w.alice1, first.id))?.server_ts !== null, { message: 'server time', timeoutMs: 5000 });
    const row = await messageOn(w.alice1, first.id);
    expect(row).toMatchObject({ status: 'delivered', sort_ts: row?.server_ts });
    expect(await w.alice1.store.outbox.count()).toBe(0);

    const reply = await w.bob1.engine.sendMessage(w.aliceId, 'reply after first');
    await waitFor(async () => (await messageOn(w.alice1, reply.id)) !== null);
    const bodies = async (phone: typeof w.alice1, peer: string) => (await messagesOf(phone, peer)).map((m) => m.body);
    expect(await bodies(w.alice1, w.bobId)).toEqual(['first', 'reply after first']);
    expect(await bodies(w.bob1, w.aliceId)).toEqual(['first', 'reply after first']);
  });

  it('logout sends the receipts queued while its flush runs, never a stale payload', async () => {
    const w = await createWorld({ secondDevices: false, timings: { receiptDebounceMs: 5000 } });
    const m1 = await w.alice1.engine.sendMessage(w.bobId, 'm1');
    await waitFor(async () => (await messageOn(w.bob1, m1.id)) !== null);
    // m1's delivered receipt waits in its coalescing window when the logout starts.
    await waitFor(async () => (await w.bob1.store.outbox.listAll()).some((r) => r.kind === 'receipt'));
    const api = w.bob1.session.api;
    const post = api.postEnvelopes.bind(api);
    let m2: MessageRow | null = null;
    let held = false;
    jest.spyOn(api, 'postEnvelopes').mockImplementation(async (envelopes, completeForUserIds) => {
      if (!held) {
        // While the flush sends m1's receipt, m2 is pushed to bob1 and its receipt is queued.
        held = true;
        const sent = await w.alice1.engine.sendMessage(w.bobId, 'm2');
        m2 = sent;
        await waitFor(
          async () => (await w.bob1.store.outbox.listAll()).some((r) => r.kind === 'receipt' && (r.payload ?? '').includes(sent.id)),
          { message: "m2's receipt queued" },
        );
      }
      return post(envelopes, completeForUserIds);
    });
    expect(await w.bob1.engine.logout()).toEqual({ status: 'loggedOut' });
    expect(m2).not.toBeNull();
    await waitFor(async () => (await statusOn(w.alice1, m1.id)) === 'delivered', { message: 'm1 delivered' });
    await waitFor(async () => (await statusOn(w.alice1, m2!.id)) === 'delivered', { message: 'm2 delivered' });
  });
});
