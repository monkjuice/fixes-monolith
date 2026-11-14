import { apiError, waitFor, waitForQuiet } from '../../../test-utils';
import { toBase64 } from '../../crypto/encoding';
import { generateIdentityKeyPair } from '../../crypto/identity';
import { uuidv4 } from '../../crypto/random';
import { SecureKeys } from '../../session/secureItems';
import type { MessageRow } from '../../db/types';
import {
  addLinkedDevice,
  connected,
  createWorld,
  disposePhones,
  messageOn,
  messagesOf,
  noErrors,
  statusOn,
  trackPhone,
  type World,
} from '../../messaging/__tests__/world';
import type { TestPhone } from '../../../test-utils';

// Integration tests run several phones on real timers; leave room for slow machines.
jest.setTimeout(20_000);

afterEach(async () => {
  await disposePhones();
});

async function newUnlinkedDevice(w: World, name: string): Promise<TestPhone> {
  const phone = trackPhone(w.server, { name, timings: { historyBatchSize: 1 } });
  await phone.login('alice', w.password);
  expect(phone.session.getState().status).toBe('needsLink');
  await connected(phone);
  return phone;
}

/** Stores `count` long outgoing messages directly, so the history needs several 48 kB chunks. */
async function seedHistory(phone: TestPhone, peer: string, count: number, prefix: string): Promise<string[]> {
  const ids: string[] = [];
  await phone.store.transaction(async (tx) => {
    for (let i = 0; i < count; i++) {
      const row: MessageRow = {
        id: uuidv4(),
        peer_user_id: peer,
        direction: 'out',
        sender_user_id: phone.userId,
        body: `${prefix}${i} ${'x'.repeat(3000)}`,
        sent_at: 1_700_000_000_000 + i,
        server_ts: 1_700_000_000_000 + i,
        sort_ts: 1_700_000_000_000 + i,
        received_at: null,
        status: 'delivered',
      };
      await tx.messages.insertOrIgnore(row);
      ids.push(row.id);
    }
  });
  return ids;
}

describe('device linking and history transfer (§9)', () => {
  it('links a new device end to end: certificate, identity key, history, then messaging', async () => {
    const w = await createWorld({ secondDevices: false });
    const hello = await w.alice1.engine.sendMessage(w.bobId, 'history 1');
    const reply = await w.bob1.engine.sendMessage(w.aliceId, 'history 2');
    await waitFor(async () => (await statusOn(w.alice1, hello.id)) === 'delivered');
    await waitFor(async () => (await messageOn(w.alice1, reply.id)) !== null);
    const pending = await w.alice1.store.transaction(async (tx) => {
      // A message still pending on the old device must arrive as failed (never auto-sent).
      const row: MessageRow = {
        id: uuidv4(),
        peer_user_id: w.bobId,
        direction: 'out',
        sender_user_id: w.aliceId,
        body: 'unsent',
        sent_at: 1,
        server_ts: null,
        sort_ts: 1,
        received_at: null,
        status: 'pending',
      };
      await tx.messages.insertOrIgnore(row);
      return row;
    });

    const alice2 = await newUnlinkedDevice(w, 'alice2');
    expect(await alice2.session.getIdentity()).toBeNull();
    const qr = await alice2.engine.createLinkQr();
    expect(qr).toMatch(/^fixes-link:1:[0-9a-f-]{36}:[0-9a-f-]{36}:[A-Za-z0-9_-]{43}:[A-Za-z0-9_-]{43}$/);
    expect(alice2.engine.incomingLink.get()).toMatchObject({ phase: 'waiting', qr });
    // The same code while the transfer is open.
    expect(await alice2.engine.createLinkQr()).toBe(qr);

    await w.alice1.engine.startLink(qr);
    expect(w.alice1.engine.outgoingLink.get()).toMatchObject({ phase: 'done', error: null, totalChunks: 1, sentChunks: 1 });

    await waitFor(() => alice2.engine.incomingLink.get().phase === 'complete', { message: 'transfer complete' });
    await waitFor(() => alice2.session.getState().status === 'ready', { message: 'session ready' });
    const identity = await alice2.session.getIdentity();
    expect(identity && toBase64(identity.publicKey)).toBe(w.server.users.get(w.aliceId)?.identityKey);
    expect(alice2.engine.incomingLink.get()).toMatchObject({ linkReceived: true, receivedChunks: 1, totalChunks: 1 });

    // History imported per §10 (history import keeps incoming status, pending becomes failed).
    expect(await messageOn(alice2, hello.id)).toMatchObject({ direction: 'out', status: 'delivered', body: 'history 1' });
    expect(await messageOn(alice2, reply.id)).toMatchObject({ direction: 'in', status: 'received' });
    expect(await messageOn(alice2, pending.id)).toMatchObject({ status: 'failed' });
    expect(await alice2.store.conversations.get(w.bobId)).toMatchObject({ peer_username: 'bob', unread_count: 1 });
    expect(await alice2.store.contactIdentities.get(w.bobId)).toMatchObject({
      identity_key: w.server.users.get(w.bobId)?.identityKey,
    });
    // The transfer key is deleted on completion.
    const [transfer] = await alice2.store.sql.getAllAsync<{ transfer_key: string | null; completed_at: number | null }>(
      'SELECT transfer_key, completed_at FROM history_transfers',
    );
    expect(transfer.transfer_key).toBeNull();
    expect(transfer.completed_at).not.toBeNull();

    // The new device now sends, and the old one receives its sync copy.
    const fromNew = await alice2.engine.sendMessage(w.bobId, 'from my new phone');
    await waitFor(async () => (await messageOn(w.bob1, fromNew.id)) !== null);
    await waitFor(async () => (await messageOn(w.alice1, fromNew.id)) !== null);
    noErrors({ phones: [w.alice1, w.bob1, alice2] });
  });

  it('survives an interruption: other devices are ignored, Resend starts a new attempt', async () => {
    const w = await createWorld({ secondDevices: false, timings: { historyBatchSize: 1 } });
    const history = await seedHistory(w.alice1, w.bobId, 40, 'h');
    const alice3 = await addLinkedDevice(w.alice1, 'alice3', 'alice', w.password);
    const [onlyOnAlice3] = await seedHistory(alice3, w.bobId, 1, 'only-on-alice3-');
    const alice2 = await newUnlinkedDevice(w, 'alice2');
    const qr = await alice2.engine.createLinkQr();
    const alice1Device = w.alice1.deviceId;

    // alice1's third POST (link, chunk 0, chunk 1) never reaches the server.
    let posts = 0;
    w.server.interceptor = (request) => {
      if (request.method === 'POST' && request.path === '/v1/envelopes' && w.server.deviceOfRequest(request)?.id === alice1Device) {
        posts++;
        if (posts === 3) throw new TypeError('Network request failed');
      }
      return undefined;
    };
    await w.alice1.engine.startLink(qr);
    expect(w.alice1.engine.outgoingLink.get()).toMatchObject({
      phase: 'failed',
      canResend: true,
      error: { code: 'interrupted' },
      sentChunks: 1,
    });
    const total = w.alice1.engine.outgoingLink.get().totalChunks;
    expect(total).toBeGreaterThanOrEqual(3);
    await waitFor(() => alice2.engine.incomingLink.get().receivedChunks === 1, { message: 'first chunk' });
    expect(alice2.engine.incomingLink.get()).toMatchObject({ phase: 'receiving', totalChunks: total });

    // Another linked device with the same QR: everything it sends is ignored (bound to alice1).
    await alice3.engine.startLink(qr);
    expect(alice3.engine.outgoingLink.get().phase).toBe('done');
    await waitFor(() => w.server.pendingFor(alice2.deviceId).length === 0, { message: 'alice3 chunks consumed' });
    expect(alice2.engine.incomingLink.get()).toMatchObject({ phase: 'receiving', receivedChunks: 1 });
    expect(await messageOn(alice2, onlyOnAlice3)).toBeNull();

    // Resend: a new attempt from the bound device resets the received seqs and completes.
    w.server.interceptor = null;
    await w.alice1.engine.resendLink();
    expect(w.alice1.engine.outgoingLink.get()).toMatchObject({ phase: 'done', attempt: 2, sentChunks: total });
    await waitFor(() => alice2.engine.incomingLink.get().phase === 'complete', { message: 'complete after resend' });
    expect(alice2.engine.incomingLink.get()).toMatchObject({ receivedChunks: total, totalChunks: total });
    const imported = await messagesOf(alice2, w.bobId);
    expect(imported.filter((m) => history.includes(m.id))).toHaveLength(40);
    expect(await messageOn(alice2, onlyOnAlice3)).toBeNull();
  });

  it('refuses a transfer after 30 minutes without a chunk', async () => {
    const w = await createWorld({ secondDevices: false });
    const alice2 = await newUnlinkedDevice(w, 'alice2');
    const qr = await alice2.engine.createLinkQr();
    alice2.clock.advance(31 * 60_000);
    await waitFor(() => alice2.engine.incomingLink.get().phase === 'expired', { message: 'expired' });
    await w.alice1.engine.startLink(qr);
    // A's side cannot know; B dropped the link because the transfer (and its key) is gone.
    expect(w.alice1.engine.outgoingLink.get().phase).toBe('done');
    await waitFor(() => w.server.pendingFor(alice2.deviceId).length === 0);
    expect(await alice2.session.getIdentity()).toBeNull();
    expect(alice2.engine.incomingLink.get().phase).toBe('expired');
    // A new code starts a new transfer.
    const fresh = await alice2.engine.createLinkQr();
    expect(fresh).not.toBe(qr);
    expect(alice2.engine.incomingLink.get().phase).toBe('waiting');
  });

  it('refuses the rest of a transfer after 10 minutes of inactivity', async () => {
    const w = await createWorld({ secondDevices: false, timings: { historyBatchSize: 1 } });
    await seedHistory(w.alice1, w.bobId, 40, 'h');
    const alice2 = await newUnlinkedDevice(w, 'alice2');
    const qr = await alice2.engine.createLinkQr();
    const alice1Device = w.alice1.deviceId;
    let posts = 0;
    w.server.interceptor = (request) => {
      if (request.method === 'POST' && request.path === '/v1/envelopes' && w.server.deviceOfRequest(request)?.id === alice1Device) {
        posts++;
        if (posts >= 3) throw new TypeError('Network request failed');
      }
      return undefined;
    };
    await w.alice1.engine.startLink(qr);
    await waitFor(() => alice2.engine.incomingLink.get().receivedChunks === 1);
    alice2.clock.advance(11 * 60_000);
    await waitFor(() => alice2.engine.incomingLink.get().phase === 'expired', { message: 'expired by inactivity' });
    w.server.interceptor = null;
    await w.alice1.engine.resendLink();
    await waitFor(() => w.server.pendingFor(alice2.deviceId).length === 0);
    expect(alice2.engine.incomingLink.get()).toMatchObject({ phase: 'expired', receivedChunks: 1 });
  });

  it('refuses a QR whose device is not listed with exactly that key', async () => {
    const w = await createWorld({ secondDevices: false });
    const alice2 = await newUnlinkedDevice(w, 'alice2');
    const qr = await alice2.engine.createLinkQr();
    const parts = qr.split(':');
    const otherKey = parts.slice();
    otherKey[4] = 'A'.repeat(42) + 'A';
    await w.alice1.engine.startLink(otherKey.join(':'));
    expect(w.alice1.engine.outgoingLink.get()).toMatchObject({ phase: 'failed', error: { code: 'key_mismatch' }, canResend: false });
    const unknownDevice = parts.slice();
    unknownDevice[3] = uuidv4();
    await w.alice1.engine.startLink(unknownDevice.join(':'));
    expect(w.alice1.engine.outgoingLink.get().error?.code).toBe('device_not_found');
    await w.alice1.engine.startLink('https://example.com/not-a-link');
    expect(w.alice1.engine.outgoingLink.get().error?.code).toBe('invalid_qr');
    // Nothing was certified.
    expect(w.server.devices.get(alice2.deviceId)?.certificate).toBeNull();
  });

  it('links a phone that still holds an identity key from before an identity reset', async () => {
    const w = await createWorld({ secondDevices: false });
    // Phone P held Alice's AIK K1 (logout keeps the identity item, §12.1).
    const phoneP = trackPhone(w.server, { name: 'P' });
    phoneP.copyIdentityFrom(w.alice1);
    const k1 = w.server.users.get(w.aliceId)?.identityKey;
    // Alice lost alice1: a new phone N resets the identity to K2 (alice1 is revoked).
    const phoneN = trackPhone(w.server, { name: 'N' });
    await phoneN.login('alice', w.password);
    await phoneN.session.resetIdentity(w.password);
    await connected(phoneN);
    const k2 = w.server.users.get(w.aliceId)?.identityKey;
    expect(k2).not.toBe(k1);

    // Back on P: K1 is not the account key, so P must be linked; the transfer replaces K1.
    await phoneP.login('alice', w.password);
    expect(phoneP.session.getState().status).toBe('needsLink');
    await connected(phoneP);
    const qr = await phoneP.engine.createLinkQr();
    await phoneN.engine.startLink(qr);
    expect(phoneN.engine.outgoingLink.get()).toMatchObject({ phase: 'done', error: null });
    await waitFor(() => phoneP.engine.incomingLink.get().phase === 'complete', { message: 'transfer complete' });
    await waitFor(() => phoneP.session.getState().status === 'ready', { message: 'P ready' });
    const identity = await phoneP.session.getIdentity();
    expect(identity && toBase64(identity.publicKey)).toBe(k2);

    // P's own devices are judged under K2: its sends include N (no endless stale_devices).
    const sent = await phoneP.engine.sendMessage(w.bobId, 'from P');
    await waitFor(async () => (await messageOn(w.bob1, sent.id)) !== null, { message: 'bob received' });
    await waitFor(async () => (await messageOn(phoneN, sent.id)) !== null, { message: 'sync copy on N' });
    expect(['sent', 'delivered']).toContain(await statusOn(phoneP, sent.id));
    noErrors({ phones: [phoneP, phoneN, w.bob1] });
  });

  it('links the loser of the race to create the identity, replacing the key it held', async () => {
    const w = await createWorld({ secondDevices: false });
    const accountKey = w.server.users.get(w.aliceId)!.identityKey;
    // The loser holds a key that is not the account's (from an older install).
    const loser = trackPhone(w.server, { name: 'loser' });
    const junk = generateIdentityKeyPair();
    loser.secureStore.items.set(SecureKeys.identity(w.aliceId), JSON.stringify({ public_key: toBase64(junk.publicKey), secret_key: toBase64(junk.secretKey) }));
    // It logs in while the account still looks identity-less; its PUT loses the race.
    w.server.users.get(w.aliceId)!.identityKey = null;
    w.server.interceptor = (req) => {
      if (req.method === 'PUT' && req.path === '/v1/users/me/identity') {
        w.server.users.get(w.aliceId)!.identityKey = accountKey;
        w.server.interceptor = null;
        return apiError(409, 'identity_exists');
      }
      return undefined;
    };
    await loser.login('alice', w.password);
    expect(loser.session.getState().status).toBe('needsLink');
    await connected(loser);

    const qr = await loser.engine.createLinkQr();
    await w.alice1.engine.startLink(qr);
    expect(w.alice1.engine.outgoingLink.get().phase).toBe('done');
    await waitFor(() => loser.engine.incomingLink.get().phase === 'complete', { message: 'transfer complete' });
    await waitFor(() => loser.session.getState().status === 'ready', { message: 'loser ready' });
    expect(toBase64((await loser.session.getIdentity())!.publicKey)).toBe(accountKey);
  });

  it('keeps waiting for the link (same QR, runtime running) when a re-check of the link state fails', async () => {
    const w = await createWorld({ secondDevices: false });
    const alice2 = await newUnlinkedDevice(w, 'alice2');
    const qr = await alice2.engine.createLinkQr();
    const sessionStatuses: string[] = [];
    alice2.session.subscribe((s) => sessionStatuses.push(s.status));
    const engineStatuses: string[] = [];
    alice2.engine.subscribe((s) => engineStatuses.push(s.status));
    let failures = 0;
    w.server.interceptor = (req) => {
      if (req.method === 'GET' && req.path === '/v1/users/me' && w.server.deviceOfRequest(req)?.id === alice2.deviceId && failures < 2) {
        failures++;
        if (failures === 1) throw new TypeError('Network request failed');
        return apiError(400, 'validation_error');
      }
      return undefined;
    };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // Another device of the account logs in or is certified: devices_changed makes alice2 re-check.
      w.server.devicesChanged(w.aliceId);
      await waitFor(() => failures === 1, { message: 'network failure' });
      await waitForQuiet(w.server);
      w.server.devicesChanged(w.aliceId);
      await waitFor(() => failures === 2, { message: 'refused re-check' });
      await waitForQuiet(w.server);
      expect(alice2.session.getState().status).toBe('needsLink');
      expect(alice2.engine.getState().status).toBe('linking');
      expect(alice2.engine.incomingLink.get()).toMatchObject({ phase: 'waiting', qr });

      await w.alice1.engine.startLink(qr);
      await waitFor(() => alice2.engine.incomingLink.get().phase === 'complete', { message: 'transfer complete' });
      await waitFor(() => alice2.session.getState().status === 'ready', { message: 'ready' });
    } finally {
      warn.mockRestore();
    }
    expect(sessionStatuses).not.toContain('loading');
    expect(engineStatuses).not.toContain('stopped');
  });

  it('"Receive history" on a linked device never re-checks the link state (no Splash on a network blip)', async () => {
    const w = await createWorld({ secondDevices: false });
    const [old] = await seedHistory(w.alice1, w.bobId, 1, 'old-');
    const alice2 = await addLinkedDevice(w.alice1, 'alice2', 'alice', w.password);
    expect(alice2.session.getState().status).toBe('ready');
    const qr = await alice2.engine.createLinkQr();
    const sessionStatuses: string[] = [];
    alice2.session.subscribe((s) => sessionStatuses.push(s.status));
    const engineStatuses: string[] = [];
    alice2.engine.subscribe((s) => engineStatuses.push(s.status));
    // Any account check from alice2 would fail like a network blip.
    let accountChecks = 0;
    w.server.interceptor = (req) => {
      if (req.method === 'GET' && req.path === '/v1/users/me' && w.server.deviceOfRequest(req)?.id === alice2.deviceId) {
        accountChecks++;
        throw new TypeError('Network request failed');
      }
      return undefined;
    };
    await w.alice1.engine.startLink(qr);
    expect(w.alice1.engine.outgoingLink.get().phase).toBe('done');
    await waitFor(() => alice2.engine.incomingLink.get().phase === 'complete', { message: 'history received' });
    expect(await messageOn(alice2, old)).not.toBeNull();
    expect(accountChecks).toBe(0);
    expect(sessionStatuses).not.toContain('loading');
    expect(engineStatuses).not.toContain('stopped');
    expect(alice2.engine.getState().status).toBe('ready');
  });
});
