import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ApiError } from '../src/core/api/errors';
import type { OutgoingEnvelope, User } from '../src/core/api/types';
import { tooManyDevicesDetails } from '../src/core/api/validate';
import { generateDeviceKeyPair } from '../src/core/crypto/deviceKeys';
import { toBase64 } from '../src/core/crypto/encoding';
import { randomBytes, uuidv4 } from '../src/core/crypto/random';
import type { MessageRow } from '../src/core/db/types';
import type { MessagingTimings } from '../src/core/messaging/timings';
import { RealtimeSocket } from '../src/core/realtime/socket';
import { SecureKeys } from '../src/core/session/secureItems';
import { waitFor } from '../src/test-utils';
import {
  createMessagingPhone,
  e2eApiConfig,
  randomPassword,
  uniqueUsername,
  type MessagingPhone,
} from './support/harness';
import { gradientPng } from './support/png';

/**
 * The whole product flow against a real fixes-server, driving the real core (API client,
 * SessionManager, messaging engine, linking, backups) over HTTP and WebSocket:
 *
 * alice (A1, A2, A3) and bob (B1, B2, later B3) become friends and message each other: live pushes,
 * receipts, offline catch-up, sync copies, device linking with a multi-chunk history transfer,
 * fan-out to every device, revocation, a non-friend (carol), token rotation, socket replacement and
 * ping/pong, backup export/import, an avatar upload, mailbox caps with the gap flag, an identity
 * reset seen from the other side, and logout. Steps run in order and share state.
 */

// Resolved at load time: without FIXES_E2E_API_URL the suite fails once, with the harness's message.
const API = e2eApiConfig();
const WAIT = { timeoutMs: 20_000 };
const phones: MessagingPhone[] = [];
const tempDirs: string[] = [];

beforeAll(async () => {
  const health = await fetch(`${API.apiBaseUrl}/healthz`).catch((cause: unknown) => {
    throw new Error(`fixes-server is not reachable at ${API.apiBaseUrl}`, { cause });
  });
  if (health.status !== 200) throw new Error(`fixes-server at ${API.apiBaseUrl} is not healthy (${health.status})`);
});

afterAll(async () => {
  for (const phone of phones) await phone.cleanup();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function phone(name: string, timings?: Partial<MessagingTimings>): MessagingPhone {
  const created = createMessagingPhone({ deviceName: name, timings, config: API });
  phones.push(created);
  return created;
}

function deviceIdOf(p: MessagingPhone): string {
  const active = p.manager.getActiveDevice();
  if (!active) throw new Error(`${p.name} is not signed in`);
  return active.deviceId;
}

async function connected(p: MessagingPhone): Promise<void> {
  await waitFor(() => p.engine.getState().connection === 'ready', { ...WAIT, message: `${p.name} socket ready` });
}

async function message(p: MessagingPhone, id: string): Promise<MessageRow | null> {
  return p.manager.getLocalStore().messages.get(id);
}

async function arrives(p: MessagingPhone, id: string): Promise<MessageRow> {
  await waitFor(async () => (await message(p, id)) !== null, { ...WAIT, message: `message on ${p.name}` });
  const row = await message(p, id);
  if (!row) throw new Error(`message vanished on ${p.name}`);
  return row;
}

async function reachesStatus(p: MessagingPhone, id: string, status: string): Promise<void> {
  await waitFor(async () => (await message(p, id))?.status === status, {
    ...WAIT,
    message: `${status} on ${p.name}`,
  });
}

/** Every row of one conversation, oldest first (listPage returns at most 500 per call). */
async function allRows(p: MessagingPhone, peer: string): Promise<MessageRow[]> {
  const rows: MessageRow[] = [];
  for (;;) {
    const last = rows.at(-1);
    const page = await p.manager.getLocalStore().messages.listPage(peer, {
      limit: 500,
      before: last ? { sortTs: last.sort_ts, id: last.id } : undefined,
    });
    rows.push(...page);
    if (page.length < 500) return rows.reverse();
  }
}

/** All rows of one conversation, oldest first, without system messages. */
async function conversation(p: MessagingPhone, peer: string): Promise<MessageRow[]> {
  return (await allRows(p, peer)).filter((r) => r.direction !== 'system');
}

async function systemMessages(p: MessagingPhone, peer: string): Promise<MessageRow[]> {
  return (await allRows(p, peer)).filter((r) => r.direction === 'system');
}

function summary(rows: MessageRow[]): { id: string; direction: string; body: string }[] {
  return rows.map((r) => ({ id: r.id, direction: r.direction, body: r.body }));
}

async function mailboxSize(p: MessagingPhone): Promise<number> {
  return (await p.manager.api.getEnvelopes(500)).envelopes.length;
}

/** No outbox work left and an empty mailbox on the server, for every listed phone. */
async function drained(list: MessagingPhone[]): Promise<boolean> {
  for (const p of list) {
    if ((await p.manager.getLocalStore().outbox.count()) > 0) return false;
    if ((await mailboxSize(p)) > 0) return false;
  }
  return true;
}

/** Envelopes no device can open (random bytes), as a hostile or broken client could send. */
function junkEnvelopes(recipient: string, count: number): OutgoingEnvelope[] {
  return Array.from({ length: count }, () => ({
    recipient_device_id: recipient,
    nonce: toBase64(randomBytes(24)),
    ciphertext: toBase64(randomBytes(272)),
  }));
}

describe('fixes-app core against a real fixes-server', () => {
  const aliceName = uniqueUsername('alice');
  const bobName = uniqueUsername('bob');
  const carolName = uniqueUsername('carol');
  const password = randomPassword();
  let alice1: MessagingPhone;
  let alice2: MessagingPhone;
  let alice3: MessagingPhone;
  let bob1: MessagingPhone;
  let bob2: MessagingPhone;
  let bob3: MessagingPhone;
  let carol1: MessagingPhone;
  let aliceId: string;
  let bobId: string;
  let bobProfile: User;
  let recoveryKey: string;
  let backupFile: { name: string; contents: string };

  it('registers alice and bob; their first devices create their identities', async () => {
    alice1 = phone('A1');
    // Small pages, so the offline catch-up below drains the mailbox in several GETs.
    bob1 = phone('B1', { pageSize: 2 });
    aliceId = (await alice1.manager.register(aliceName, password)).id;
    const bob = await bob1.manager.register(bobName, password);
    bobId = bob.id;
    bobProfile = bob;
    await alice1.manager.start();
    await bob1.manager.start();
    await alice1.manager.login(aliceName, password);
    await bob1.manager.login(bobName, password);
    expect(alice1.manager.getState().status).toBe('ready');
    expect(bob1.manager.getState().status).toBe('ready');
    expect(alice1.manager.getState().user?.identity_key).toEqual(expect.any(String));
    const { devices } = await alice1.manager.api.listMyDevices();
    expect(devices).toEqual([
      expect.objectContaining({ id: deviceIdOf(alice1), current: true, certificate: expect.any(String) }),
    ]);
    await connected(alice1);
    await connected(bob1);
  });

  it('finds bob by search and makes them friends (request + accept)', async () => {
    const { users } = await alice1.manager.api.searchUsers(bobName.slice(0, 12));
    expect(users.map((u) => u.id)).toContain(bobId);
    const request = await alice1.manager.api.createFriendRequest(bobId);
    expect(request.status).toBe('pending');
    const { incoming } = await bob1.manager.api.listFriendRequests();
    expect(incoming.map((r) => r.from_user.id)).toEqual([aliceId]);
    const { friend } = await bob1.manager.api.acceptFriendRequest(incoming[0].id);
    expect(friend.id).toBe(aliceId);
    expect((await alice1.manager.api.listFriends()).friends.map((f) => f.id)).toEqual([bobId]);
  });

  it('turns the server’s error bodies (§5.1) into typed client errors', async () => {
    const api = alice1.manager.api;
    // Uniqueness is case-insensitive (username_lower).
    await expect(api.register(aliceName.toUpperCase(), password)).rejects.toMatchObject({
      status: 409,
      code: 'username_taken',
    });
    await expect(api.register('no spaces allowed', password)).rejects.toMatchObject({
      status: 422,
      code: 'validation_error',
      details: { fields: { username: expect.any(String) } },
    });
    const device = { name: 'wrong password', public_key: toBase64(generateDeviceKeyPair().publicKey) };
    await expect(api.login(aliceName, randomPassword(), device)).rejects.toMatchObject({
      status: 401,
      code: 'invalid_credentials',
    });
    await expect(api.createFriendRequest(bobId)).rejects.toMatchObject({ status: 409, code: 'already_friends' });
    await expect(api.createFriendRequest(aliceId)).rejects.toMatchObject({ status: 400, code: 'cannot_friend_self' });
    await expect(api.getUser(uuidv4())).rejects.toMatchObject({ status: 404, code: 'not_found' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixes-e2e-notimage-'));
    tempDirs.push(dir);
    const notImage = path.join(dir, 'avatar.jpg');
    fs.writeFileSync(notImage, 'this is not an image');
    await expect(api.uploadAvatar(notImage)).rejects.toMatchObject({ status: 400, code: 'invalid_image' });
  });

  it('delivers A1 → B1 live over the WebSocket, then delivered and read receipts reach A1', async () => {
    const pushedBefore = bob1.traffic.pushedEnvelopeIds().length;
    const drainsBefore = bob1.traffic.mailboxFetches().length;
    const hello = await alice1.engine.sendMessage(bobId, 'hello bob', { profile: bobProfile });
    const received = await arrives(bob1, hello.id);
    expect(received).toMatchObject({
      direction: 'in',
      peer_user_id: aliceId,
      sender_user_id: aliceId,
      body: 'hello bob',
      status: 'received',
    });
    // Live: a pushed envelope frame, and no mailbox drain in between.
    expect(bob1.traffic.pushedEnvelopeIds().length).toBeGreaterThan(pushedBefore);
    expect(bob1.traffic.mailboxFetches().length).toBe(drainsBefore);
    // One envelope per device of bob (B1) plus alice's other devices (none yet).
    const post = alice1.traffic.envelopePosts().at(-1);
    expect(post).toMatchObject({ status: 201, recipients: [deviceIdOf(bob1)], completeFor: [bobId, aliceId] });
    // server_ts/sort_ts come from the POST response.
    const sent = await message(alice1, hello.id);
    expect(sent?.server_ts).toEqual(expect.any(Number));
    expect(sent?.sort_ts).toBe(sent?.server_ts);
    expect(received.server_ts).toBe(sent?.server_ts);

    await reachesStatus(alice1, hello.id, 'delivered');
    expect(await bob1.engine.markConversationRead(aliceId)).toBe(1);
    await reachesStatus(alice1, hello.id, 'read');
    expect((await bob1.manager.getLocalStore().conversations.get(aliceId))?.unread_count).toBe(0);

    const reply = await bob1.engine.sendMessage(aliceId, 'hi alice');
    await arrives(alice1, reply.id);
    expect(await alice1.engine.markConversationRead(bobId)).toBe(1);
    await reachesStatus(bob1, reply.id, 'read');
    // Bob's placeholder conversation got alice's name from the server.
    await waitFor(
      async () => (await bob1.manager.getLocalStore().conversations.get(aliceId))?.peer_username === aliceName,
      { ...WAIT, message: 'profile fetched' },
    );
  });

  it('catches up an offline device from its mailbox, page by page', async () => {
    bob1.engine.detach();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push((await alice1.engine.sendMessage(bobId, `while you were away ${i}`)).id);
    for (const id of ids) await reachesStatus(alice1, id, 'sent');
    expect(await mailboxSize(bob1)).toBe(5);

    const drainsBefore = bob1.traffic.mailboxFetches().length;
    const pushedBefore = bob1.traffic.pushedEnvelopeIds();
    bob1.engine.attach();
    for (const id of ids) await arrives(bob1, id);
    // pageSize 2: three non-empty pages, then the empty one that ends the drain.
    const drains = () => bob1.traffic.mailboxFetches().slice(drainsBefore);
    await waitFor(() => drains().some((d) => d.envelopeIds?.length === 0), { ...WAIT, message: 'drain finished' });
    expect(drains().map((d) => d.envelopeIds?.length)).toEqual([2, 2, 1, 0]);
    expect(new Set(drains().flatMap((d) => d.envelopeIds ?? [])).size).toBe(5);
    expect(bob1.traffic.pushedEnvelopeIds()).toEqual(pushedBefore);
    await waitFor(async () => (await mailboxSize(bob1)) === 0, { ...WAIT, message: 'B1 acked' });
    for (const id of ids) await reachesStatus(alice1, id, 'delivered');
    // Sort order follows the server timestamps.
    const rows = await conversation(bob1, aliceId);
    expect(rows.map((r) => r.sort_ts)).toEqual([...rows.map((r) => r.sort_ts)].sort((a, b) => a - b));
  });

  it('links A2 from A1 by its QR code and transfers a multi-chunk history', async () => {
    // Multi-byte bodies at the 4000-code-point limit: chunks are measured in UTF-8 bytes (≤ 48 000).
    const euro = '€'.repeat(4000);
    const emoji = '😀'.repeat(4000);
    const big: string[] = [];
    for (let i = 0; i < 8; i += 1) big.push((await alice1.engine.sendMessage(bobId, i % 2 === 0 ? euro : emoji)).id);
    // Settle the receipts first, so the snapshot and A1's rows are compared at the same statuses.
    for (const id of big) await reachesStatus(alice1, id, 'delivered');

    alice2 = phone('A2');
    await alice2.manager.start();
    await alice2.manager.login(aliceName, password);
    expect(alice2.manager.getState().status).toBe('needsLink');
    await connected(alice2);
    const qr = await alice2.engine.createLinkQr();
    expect(qr.startsWith('fixes-link:1:')).toBe(true);

    await alice1.engine.startLink(qr);
    const outgoing = alice1.engine.outgoingLink.get();
    expect(outgoing).toMatchObject({ phase: 'done', error: null });
    expect(outgoing.totalChunks).toBeGreaterThanOrEqual(3);
    expect(outgoing.sentChunks).toBe(outgoing.totalChunks);
    await waitFor(() => alice2.engine.incomingLink.get().phase === 'complete', { ...WAIT, message: 'transfer complete' });
    await waitFor(() => alice2.manager.getState().status === 'ready', { ...WAIT, message: 'A2 linked' });
    await connected(alice2);

    const identity1 = await alice1.manager.getIdentity();
    const identity2 = await alice2.manager.getIdentity();
    expect(identity2 && toBase64(identity2.publicKey)).toBe(identity1 && toBase64(identity1.publicKey));
    const { devices } = await alice1.manager.api.listMyDevices();
    expect(devices.find((d) => d.id === deviceIdOf(alice2))?.certificate).toEqual(expect.any(String));

    const history1 = await conversation(alice1, bobId);
    const history2 = await conversation(alice2, bobId);
    expect(history2).toHaveLength(15);
    expect(summary(history2)).toEqual(summary(history1));
    expect(history2.map((r) => r.status)).toEqual(history1.map((r) => r.status));
    expect((await alice2.manager.getLocalStore().conversations.get(bobId))?.peer_username).toBe(bobName);
    expect((await alice2.manager.getLocalStore().contactIdentities.get(bobId))?.identity_key).toBe(
      (await alice1.manager.getLocalStore().contactIdentities.get(bobId))?.identity_key,
    );
    // The transfer key is deleted on completion (§9 step 5).
    const transferId = qr.split(':')[2];
    expect((await alice2.manager.getLocalStore().historyTransfers.get(transferId))?.transfer_key ?? null).toBeNull();
  });

  it('sends from A1 again: A2 gets the sync copy, B1 the message', async () => {
    const again = await alice1.engine.sendMessage(bobId, 'now with two devices');
    expect(await arrives(bob1, again.id)).toMatchObject({ direction: 'in', body: 'now with two devices' });
    expect(await arrives(alice2, again.id)).toMatchObject({
      direction: 'out',
      peer_user_id: bobId,
      sender_user_id: aliceId,
      body: 'now with two devices',
    });
    const post = alice1.traffic.envelopePosts().filter((p) => p.status === 201).at(-1);
    expect([...(post?.recipients ?? [])].sort()).toEqual([deviceIdOf(bob1), deviceIdOf(alice2)].sort());
    // Delivered receipts go to every device of the sender.
    await reachesStatus(alice1, again.id, 'delivered');
    await reachesStatus(alice2, again.id, 'delivered');
  });

  it('links B2 from B1', async () => {
    bob2 = phone('B2');
    await bob2.manager.start();
    await bob2.manager.login(bobName, password);
    expect(bob2.manager.getState().status).toBe('needsLink');
    await connected(bob2);
    await bob1.engine.startLink(await bob2.engine.createLinkQr());
    expect(bob1.engine.outgoingLink.get()).toMatchObject({ phase: 'done', error: null });
    await waitFor(() => bob2.manager.getState().status === 'ready', { ...WAIT, message: 'B2 linked' });
    await waitFor(() => bob2.engine.incomingLink.get().phase === 'complete', { ...WAIT, message: 'B2 transfer complete' });
    await connected(bob2);
    expect(summary(await conversation(bob2, aliceId))).toEqual(summary(await conversation(bob1, aliceId)));
    expect(await conversation(bob2, aliceId)).toHaveLength(16);
  });

  it('fans every message out to all four devices', async () => {
    const fromA2 = await alice2.engine.sendMessage(bobId, 'from A2');
    const fromB2 = await bob2.engine.sendMessage(aliceId, 'from B2');
    const fromA1 = await alice1.engine.sendMessage(bobId, 'from A1');
    for (const m of [fromA2, fromB2, fromA1]) {
      for (const p of [alice1, alice2, bob1, bob2]) await arrives(p, m.id);
    }
    expect((await message(alice1, fromA2.id))?.direction).toBe('out');
    expect((await message(bob1, fromB2.id))?.direction).toBe('out');
    expect(await message(alice2, fromB2.id)).toMatchObject({ direction: 'in', sender_user_id: bobId });
    const reference = (await conversation(alice1, bobId)).map((m) => m.id).sort();
    for (const [p, peer] of [
      [alice2, bobId],
      [bob1, aliceId],
      [bob2, aliceId],
    ] as const) {
      expect((await conversation(p, peer)).map((m) => m.id).sort()).toEqual(reference);
    }
  });

  it('revokes B2; later messages are not encrypted to it', async () => {
    const b2 = deviceIdOf(bob2);
    // B2's last message waits in A2's mailbox (A2 offline) while B2 is revoked.
    alice2.engine.detach();
    const lastWords = await bob2.engine.sendMessage(aliceId, 'last words from B2');
    await reachesStatus(bob2, lastWords.id, 'sent');
    // A REST refresh after B2's socket authenticated: the socket's token is older than the one in
    // memory, and its 4401 must still reach the server's refresh (the newer token is just as revoked).
    await connected(bob2);
    const before = bob2.manager.tokens.currentAccessToken();
    await new Promise((resolve) => setTimeout(resolve, 1_100)); // a JWT issued in another second
    await bob2.manager.tokens.refresh(null);
    expect(bob2.manager.tokens.currentAccessToken()).not.toBe(before);
    await bob1.manager.api.revokeDevice(b2);
    // The server closes B2's socket with 4401 and the refresh fails: signed out (§6). Revocation
    // deletes the refresh tokens, so the server can only say invalid_refresh_token here.
    await waitFor(() => bob2.manager.getState().status === 'signedOut', { ...WAIT, message: 'B2 signed out' });
    expect(['device_revoked', 'invalid_refresh_token']).toContain(bob2.manager.getState().signedOutReason);
    expect((await bob1.manager.api.listMyDevices()).devices.map((d) => d.id)).toEqual([deviceIdOf(bob1)]);

    // §4.2: A2 (fresh device cache) looks the revoked sender up by id and accepts the envelope,
    // because it was created before revoked_at.
    const requestsBefore = alice2.traffic.requests.length;
    alice2.engine.attach();
    await connected(alice2);
    expect(await arrives(alice2, lastWords.id)).toMatchObject({ direction: 'in', sender_user_id: bobId });
    const lookups = alice2.traffic.requests
      .slice(requestsBefore)
      .filter((r) => r.method === 'GET' && r.path === `/v1/users/${bobId}/devices/${b2}`);
    expect(lookups.map((r) => r.status)).toEqual([200]);

    const aliceBefore = alice1.traffic.envelopePosts().length;
    const bobBefore = bob1.traffic.envelopePosts().length;
    const afterRevoke = await alice1.engine.sendMessage(bobId, 'after the revocation');
    await arrives(bob1, afterRevoke.id);
    await arrives(alice2, afterRevoke.id);
    const bobSends = await bob1.engine.sendMessage(aliceId, 'B2 is gone');
    await arrives(alice1, bobSends.id);
    await arrives(alice2, bobSends.id);

    for (const posts of [alice1.traffic.envelopePosts().slice(aliceBefore), bob1.traffic.envelopePosts().slice(bobBefore)]) {
      const stored = posts.filter((p) => p.status === 201);
      expect(stored.length).toBeGreaterThan(0);
      for (const post of stored) expect(post.recipients).not.toContain(b2);
    }
  });

  it('refuses a non-friend (carol): no device lists, no envelopes', async () => {
    carol1 = phone('C1');
    await carol1.manager.register(carolName, password);
    await carol1.manager.start();
    await carol1.manager.login(carolName, password);
    expect(carol1.manager.getState().status).toBe('ready');
    await connected(carol1);

    await expect(carol1.manager.api.getUserDevices(aliceId)).rejects.toMatchObject({ status: 403, code: 'not_friends' });
    await expect(carol1.manager.api.getUserDevice(aliceId, deviceIdOf(alice1))).rejects.toMatchObject({
      status: 403,
      code: 'not_friends',
    });
    await expect(carol1.manager.api.postEnvelopes(junkEnvelopes(deviceIdOf(alice1), 1), [aliceId])).rejects.toMatchObject({
      status: 403,
      code: 'not_friends',
    });
    await expect(carol1.manager.api.postEnvelopes(junkEnvelopes(deviceIdOf(alice1), 1))).rejects.toMatchObject({
      status: 403,
      code: 'not_friends',
    });
    // A pending request is not a friendship; asking twice conflicts; alice declines.
    const request = await carol1.manager.api.createFriendRequest(aliceId);
    if (request.status !== 'pending') throw new Error('expected a pending request');
    await expect(carol1.manager.api.createFriendRequest(aliceId)).rejects.toMatchObject({
      status: 409,
      code: 'request_exists',
    });
    await expect(carol1.manager.api.getUserDevices(aliceId)).rejects.toMatchObject({ status: 403, code: 'not_friends' });
    await alice1.manager.api.deleteFriendRequest(request.friend_request.id);
    expect(await alice1.manager.api.listFriendRequests()).toEqual({ incoming: [], outgoing: [] });

    const spam = await carol1.engine.sendMessage(aliceId, 'let me in', {
      profile: { id: aliceId, username: aliceName, avatar_url: null },
    });
    await reachesStatus(carol1, spam.id, 'failed');
    expect(await message(alice1, spam.id)).toBeNull();

    // At most 10 active devices (§5.4): carol has one; nine more logins fill the quota.
    const login = () =>
      carol1.manager.api.login(carolName, password, {
        name: 'extra',
        public_key: toBase64(generateDeviceKeyPair().publicKey),
      });
    for (let i = 0; i < 9; i += 1) await login();
    const tooMany = await login().catch((error: unknown) => error);
    expect(tooMany).toMatchObject({ status: 409, code: 'too_many_devices' });
    const listed = tooManyDevicesDetails((tooMany as ApiError).details).devices;
    expect(listed).toHaveLength(10);
    expect(listed.map((d) => d.id)).toContain(deviceIdOf(carol1));
  });

  it('rotates A1’s refresh token; a socket replaced by a newer one (4409) resumes on foreground', async () => {
    const sessionKey = SecureKeys.session;
    const before = alice1.secureStore.items.get(sessionKey);
    const access = await alice1.manager.tokens.getAccessToken();
    const fresh = await alice1.manager.tokens.refresh(access);
    expect(fresh).not.toBe(access);
    expect(alice1.secureStore.items.get(sessionKey)).not.toBe(before);
    expect((await alice1.manager.api.getMe()).id).toBe(aliceId);

    // A rejected access token (here: forged) → 401 unauthorized → one refresh → the call is retried.
    const forged = `e2e.${toBase64(randomBytes(24))}.forged`;
    alice1.manager.tokens.setTokens({ access_token: forged, expires_in: 900 });
    const requestsBefore = alice1.traffic.requests.length;
    expect((await alice1.manager.api.getMe()).id).toBe(aliceId);
    expect(alice1.traffic.requests.slice(requestsBefore).map((r) => `${r.method} ${r.path} ${r.status}`)).toEqual([
      'GET /v1/users/me 401',
      'POST /v1/auth/refresh 200',
      'GET /v1/users/me 200',
    ]);

    // A second socket of the same device (fast pings) replaces the engine's socket with 4409.
    const extra = new RealtimeSocket({
      url: API.wsUrl,
      factory: alice1.socketFactory,
      tokens: alice1.manager.tokens,
      pingIntervalMs: 250,
    });
    const pongsBefore = alice1.traffic.frames.filter((f) => f.type === 'pong').length;
    try {
      extra.start();
      await waitFor(() => extra.status === 'ready', { ...WAIT, message: 'extra socket ready' });
      await waitFor(() => alice1.engine.getState().connection === 'replaced', { ...WAIT, message: 'engine socket replaced' });
      // The server answers pings; a silent server would make the client drop it after two periods.
      await waitFor(() => alice1.traffic.frames.filter((f) => f.type === 'pong').length >= pongsBefore + 4, {
        ...WAIT,
        message: 'pongs',
      });
      expect(extra.status).toBe('ready');
      // While replaced, the engine stays down; messages wait in the mailbox.
      const meanwhile = await bob1.engine.sendMessage(aliceId, 'while A1 was replaced');
      await arrives(alice2, meanwhile.id);
      expect(await message(alice1, meanwhile.id)).toBeNull();
      expect(alice1.engine.getState().connection).toBe('replaced');
      extra.stop();
      // Resume with a rejected token: the server closes with 4401, the client refreshes once and reconnects.
      alice1.manager.tokens.setTokens({ access_token: forged, expires_in: 900 });
      const refreshesBefore = alice1.traffic.requests.filter((r) => r.path === '/v1/auth/refresh').length;
      alice1.engine.onForeground();
      await connected(alice1);
      expect(alice1.traffic.requests.filter((r) => r.path === '/v1/auth/refresh').length).toBe(refreshesBefore + 1);
      await arrives(alice1, meanwhile.id);
    } finally {
      extra.stop();
    }
  });

  it('exports a backup on A1 and imports it on other linked alice devices', async () => {
    const preparation = await alice1.backup.beginExport();
    if (!preparation.needsConfirmation) throw new Error('the first export must ask for confirmation');
    recoveryKey = preparation.recoveryKey;
    await alice1.backup.confirmRecoveryKey(recoveryKey.split('-').at(-1) ?? '');
    const exported = await alice1.backup.exportBackup();
    const shared = alice1.files.shared.at(-1);
    if (!shared) throw new Error('no file was shared');
    expect(shared.name).toBe(exported.fileName);
    expect(shared.name).toMatch(new RegExp(`^fixes-backup-${aliceName}-\\d{8}-\\d{4}\\.fixes$`));
    backupFile = { name: shared.name, contents: shared.contents };
    const a1History = await conversation(alice1, bobId);
    expect(exported).toMatchObject({ conversations: 1, messages: a1History.length });

    // A2 already holds every message: nothing is added and nothing conflicts.
    alice2.files.nextPick = backupFile;
    const handle2 = await alice2.backup.openBackupFile();
    if (!handle2) throw new Error('A2 did not open the backup');
    const onA2 = await alice2.backup.importBackup(handle2, recoveryKey);
    expect(onA2).toMatchObject({ conversationsAdded: 0, messagesAdded: 0, contactsAdded: 0, skipped: 0, identityConflicts: [] });

    // A3: a reinstall that kept alice's identity key (self-certified at login) but lost its database.
    alice3 = phone('A3');
    alice3.secureStore.items.set(
      SecureKeys.identity(aliceId),
      alice1.secureStore.items.get(SecureKeys.identity(aliceId)) ?? '',
    );
    await alice3.manager.start();
    await alice3.manager.login(aliceName, password);
    expect(alice3.manager.getState().status).toBe('ready');
    await connected(alice3);
    expect(await conversation(alice3, bobId)).toEqual([]);

    alice3.files.nextPick = backupFile;
    const handle3 = await alice3.backup.openBackupFile();
    if (!handle3) throw new Error('A3 did not open the backup');
    await expect(alice3.backup.importBackup(handle3, 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF')).rejects.toMatchObject({
      code: 'wrong_recovery_key',
    });
    expect(await conversation(alice3, bobId)).toEqual([]);
    const onA3 = await alice3.backup.importBackup(handle3, recoveryKey);
    expect(onA3).toMatchObject({
      conversationsAdded: 1,
      messagesAdded: a1History.length,
      contactsAdded: 1,
      skipped: 0,
      identityConflicts: [],
    });
    const restored = await conversation(alice3, bobId);
    expect(summary(restored)).toEqual(summary(a1History));
    for (const row of restored) {
      const original = a1History.find((r) => r.id === row.id);
      // §10: backup incoming rows are marked read; outgoing rows keep their (highest) status.
      expect(row.status).toBe(row.direction === 'in' ? 'read' : original?.status);
    }
    expect((await alice3.manager.getLocalStore().conversations.get(bobId))?.peer_username).toBe(bobName);
    expect((await alice3.manager.getLocalStore().contactIdentities.get(bobId))?.identity_key).toBe(
      (await alice1.manager.getLocalStore().contactIdentities.get(bobId))?.identity_key,
    );
    // Importing again changes nothing.
    expect(await alice3.backup.importBackup(handle3, recoveryKey)).toMatchObject({ messagesAdded: 0, conversationsAdded: 0 });

    // A3 is a full member now: bob's next message reaches all three alice devices.
    const toAll = await bob1.engine.sendMessage(aliceId, 'welcome back A3');
    for (const p of [alice1, alice2, alice3]) await arrives(p, toAll.id);
  });

  it('uploads a generated PNG as alice’s avatar; bob sees the new URL', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixes-e2e-avatar-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'avatar.png');
    fs.writeFileSync(file, gradientPng(300, 200));
    const { user } = await alice1.manager.api.uploadAvatar(file);
    expect(user.avatar_url?.startsWith(`${API.apiBaseUrl}/media/avatars/`)).toBe(true);
    expect(user.avatar_url).toMatch(/\.jpg$/);

    const image = await fetch(user.avatar_url ?? '');
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/jpeg');
    const bytes = Buffer.from(await image.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);

    expect((await bob1.manager.api.getUser(aliceId)).avatar_url).toBe(user.avatar_url);
    await bob1.engine.refreshPeers({ force: true });
    await waitFor(
      async () => (await bob1.manager.getLocalStore().conversations.get(aliceId))?.peer_avatar_url === user.avatar_url,
      { ...WAIT, message: 'avatar refreshed on B1' },
    );
  });

  it('caps a flooded mailbox at 1 000 envelopes per sender and reports the gap once', async () => {
    alice3.engine.detach();
    const a3 = deviceIdOf(alice3);
    const store3 = alice3.manager.getLocalStore();
    const before = await store3.conversations.get(bobId);
    const earlierNotes = new Set((await systemMessages(alice3, bobId)).map((r) => r.id));
    for (let batch = 0; batch < 10; batch += 1) {
      const response = await bob1.manager.api.postEnvelopes(junkEnvelopes(a3, 100));
      expect(response.ids.every((id) => id !== null)).toBe(true);
    }
    const overflow = await bob1.manager.api.postEnvelopes(junkEnvelopes(a3, 1));
    expect(overflow).toMatchObject({ ids: [null], dropped_device_ids: [a3] });

    alice3.engine.attach();
    await waitFor(() => alice3.engine.getState().gap, { ...WAIT, message: 'gap reported' });
    await waitFor(async () => (await mailboxSize(alice3)) === 0, { timeoutMs: 40_000, message: 'A3 drained' });
    // Every junk envelope was acked as undecryptable. Consecutive failures from bob collapse into one
    // notice that counts them (§13); like every system message it is neither unread nor activity.
    const notes = (await systemMessages(alice3, bobId)).filter((r) => !earlierNotes.has(r.id));
    expect(notes.map((r) => r.body)).toEqual([`1000 messages from ${bobName} could not be decrypted`]);
    expect(await store3.conversations.get(bobId)).toMatchObject({
      unread_count: before?.unread_count,
      last_activity_at: before?.last_activity_at,
    });
    expect((await alice3.manager.api.getEnvelopes()).gap).toBe(false);
    alice3.engine.dismissGap();
    expect(alice3.engine.getState().gap).toBe(false);
  });

  it('shows bob’s identity reset to alice: safety-code warning, blocked sends until accepted', async () => {
    const oldKey = (await alice1.manager.getLocalStore().contactIdentities.get(bobId))?.identity_key;
    bob3 = phone('B3');
    await bob3.manager.start();
    await bob3.manager.login(bobName, password);
    expect(bob3.manager.getState().status).toBe('needsLink');
    await bob3.manager.resetIdentity(password);
    expect(bob3.manager.getState().status).toBe('ready');
    const newKey = bob3.manager.getState().user?.identity_key;
    expect(newKey).toEqual(expect.any(String));
    expect(newKey).not.toBe(oldKey);
    await connected(bob3);
    // Every other device of bob was revoked by the reset.
    await waitFor(() => bob1.manager.getState().status === 'signedOut', { ...WAIT, message: 'B1 signed out' });

    // Alice's next message cannot go out: the server lists only B3, certified by a key alice has
    // not accepted. The pin becomes pending, a system message appears and the message fails.
    const blocked = await alice1.engine.sendMessage(bobId, 'are you really bob?');
    await reachesStatus(alice1, blocked.id, 'failed');
    expect(await alice1.manager.getLocalStore().contactIdentities.get(bobId)).toMatchObject({
      identity_key: oldKey,
      pending_identity_key: newKey,
    });
    expect((await systemMessages(alice1, bobId)).map((m) => m.body)).toContain(`${bobName}'s safety code changed`);

    // A message from the new device, certified by the not-yet-accepted key, is still shown (§8) on
    // every alice device, including those that learn about the new key only from this envelope.
    const fromB3 = await bob3.engine.sendMessage(aliceId, 'new phone, new key', {
      profile: { id: aliceId, username: aliceName, avatar_url: null },
    });
    for (const p of [alice1, alice2, alice3]) {
      expect(await arrives(p, fromB3.id)).toMatchObject({ direction: 'in', body: 'new phone, new key' });
    }
    for (const p of [alice2, alice3]) {
      expect((await p.manager.getLocalStore().contactIdentities.get(bobId))?.pending_identity_key).toBe(newKey);
    }

    // Sending stays refused until alice accepts; then the failed message is retried and delivered.
    await expect(alice1.engine.sendMessage(bobId, 'still blocked')).rejects.toMatchObject({ code: 'identity_pending' });
    expect(await alice1.engine.acceptIdentityChange(bobId)).toBe(true);
    expect(await alice1.manager.getLocalStore().contactIdentities.get(bobId)).toMatchObject({
      identity_key: newKey,
      pending_identity_key: null,
      verified: 0,
    });
    expect(await alice1.engine.retryMessage(blocked.id)).toBe(true);
    expect(await arrives(bob3, blocked.id)).toMatchObject({ direction: 'in', sender_user_id: aliceId });
    await reachesStatus(alice1, blocked.id, 'delivered');
  });

  it('ends with every device drained and no errors logged', async () => {
    const active = [alice1, alice2, alice3, bob3, carol1];
    await waitFor(() => drained(active), { timeoutMs: 30_000, message: 'all mailboxes and outboxes empty' });
    for (const p of phones) expect(p.logger.errors()).toEqual([]);
  });

  it('logs A3 out (§13): drain, flush, revoke, forget the session', async () => {
    const a3 = deviceIdOf(alice3);
    expect(await alice3.engine.logout()).toEqual({ status: 'loggedOut' });
    expect(alice3.manager.getState().status).toBe('signedOut');
    expect(alice3.secureStore.items.has(SecureKeys.session)).toBe(false);
    const { devices } = await alice1.manager.api.listMyDevices();
    expect(devices.map((d) => d.id)).not.toContain(a3);
    expect(await drained([alice1, alice2, bob3, carol1])).toBe(true);
  });
});
