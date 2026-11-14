import { apiError, waitFor, waitForQuiet } from '../../../test-utils';
import { PLACEHOLDER_PEER_NAME } from '../conversationSummary';
import { createWorld, disposePhones, messageOn, messagesOf, noErrors, statusOn } from './world';

// Integration tests run several phones on real timers; leave room for slow machines.
jest.setTimeout(20_000);

afterEach(async () => {
  await disposePhones();
});

describe('messaging between two users with two devices each', () => {
  it('delivers to every device, syncs my other device, and moves receipts forward', async () => {
    const w = await createWorld();
    const sent = await w.alice1.engine.sendMessage(w.bobId, 'Hello Bob');
    expect(sent.status).toBe('pending');

    // Bob's devices store it as incoming; Alice's other device gets the sync copy.
    for (const bob of [w.bob1, w.bob2]) {
      await waitFor(async () => (await messageOn(bob, sent.id)) !== null, { message: `${bob.name} received` });
      expect(await messageOn(bob, sent.id)).toMatchObject({
        direction: 'in',
        sender_user_id: w.aliceId,
        peer_user_id: w.aliceId,
        body: 'Hello Bob',
        status: 'received',
      });
      expect((await bob.store.conversations.get(w.aliceId))?.unread_count).toBe(1);
    }
    await waitFor(async () => (await messageOn(w.alice2, sent.id)) !== null, { message: 'sync copy' });
    expect(await messageOn(w.alice2, sent.id)).toMatchObject({ direction: 'out', peer_user_id: w.bobId });

    // One server timestamp everywhere, used for ordering.
    const serverTs = (await messageOn(w.alice1, sent.id))!.server_ts;
    expect(serverTs).not.toBeNull();
    for (const phone of w.phones) expect((await messageOn(phone, sent.id))?.sort_ts).toBe(serverTs);

    // Delivered receipts reach both of Alice's devices.
    await waitFor(async () => (await statusOn(w.alice1, sent.id)) === 'delivered', { message: 'delivered on alice1' });
    await waitFor(async () => (await statusOn(w.alice2, sent.id)) === 'delivered', { message: 'delivered on alice2' });

    // Bob reads on bob1: read receipt to Alice, read sync to bob2 (which clears its unread count).
    expect(await w.bob1.engine.markConversationRead(w.aliceId)).toBe(1);
    expect((await w.bob1.store.conversations.get(w.aliceId))?.unread_count).toBe(0);
    await waitFor(async () => (await statusOn(w.bob2, sent.id)) === 'read', { message: 'read sync on bob2' });
    expect((await w.bob2.store.conversations.get(w.aliceId))?.unread_count).toBe(0);
    await waitFor(async () => (await statusOn(w.alice1, sent.id)) === 'read', { message: 'read on alice1' });
    await waitFor(async () => (await statusOn(w.alice2, sent.id)) === 'read', { message: 'read on alice2' });

    // Inbox summary: preview and status of the newest non-system message.
    const inbox = await w.alice1.store.conversations.listInbox();
    expect(inbox).toEqual([
      expect.objectContaining({ peer_user_id: w.bobId, peer_username: 'bob', last_body: 'Hello Bob', last_status: 'read' }),
    ]);
    noErrors(w);
  });

  it('answers in both directions and orders by server timestamp', async () => {
    const w = await createWorld({ secondDevices: false });
    const first = await w.alice1.engine.sendMessage(w.bobId, 'first');
    await waitFor(async () => (await messageOn(w.bob1, first.id)) !== null);
    // The server clock goes back: the later message gets an earlier server timestamp.
    w.server.advanceClock(-60_000);
    const reply = await w.bob1.engine.sendMessage(w.aliceId, 'reply');
    await waitFor(async () => (await messageOn(w.alice1, reply.id)) !== null);
    const onAlice = await messagesOf(w.alice1, w.bobId);
    expect(onAlice.map((m) => m.body)).toEqual(['reply', 'first']);
    expect(onAlice[0].sort_ts).toBeLessThan(onAlice[1].sort_ts);
    noErrors(w);
  });

  it('gives an unknown peer a placeholder conversation and fills in the profile later', async () => {
    const w = await createWorld({ secondDevices: false });
    const aliceDevice = w.alice1.deviceId;
    let lookups = 0;
    // Alice's first profile lookup fails, so the placeholder stays visible until the inbox refresh.
    w.server.interceptor = (request) => {
      if (request.path.startsWith('/v1/users?ids=') && w.server.deviceOfRequest(request)?.id === aliceDevice) {
        lookups++;
        if (lookups === 1) return apiError(503, 'internal_error');
      }
      return undefined;
    };
    const sent = await w.bob1.engine.sendMessage(w.aliceId, 'who am I?');
    await waitFor(async () => (await messageOn(w.alice1, sent.id)) !== null);
    await waitFor(() => lookups === 1, { message: 'background profile fetch' });
    expect((await w.alice1.store.conversations.get(w.bobId))?.peer_username).toBe(PLACEHOLDER_PEER_NAME);
    await waitFor(() => w.alice1.logger.entries.some((e) => /peer profiles/.test(e.message)));

    // Inbox refresh: names/avatars from GET /v1/users?ids=, at most once a minute unless forced.
    expect(await w.alice1.engine.refreshPeers()).toBe(true);
    expect((await w.alice1.store.conversations.get(w.bobId))?.peer_username).toBe('bob');
    w.server.users.get(w.bobId)!.avatarUrl = 'https://cdn.fixes.test/avatars/b.jpg';
    expect(await w.alice1.engine.refreshPeers()).toBe(false);
    expect((await w.alice1.store.conversations.get(w.bobId))?.peer_avatar_url).toBeNull();
    w.alice1.clock.advance(61_000);
    expect(await w.alice1.engine.refreshPeers()).toBe(true);
    expect((await w.alice1.store.conversations.get(w.bobId))?.peer_avatar_url).toBe('https://cdn.fixes.test/avatars/b.jpg');
    noErrors(w);
  });

  it('does not create receipt storms and coalesces delivered receipts', async () => {
    const w = await createWorld();
    // Bob's devices are offline while Alice sends five messages.
    w.bob1.engine.detach();
    w.bob2.engine.detach();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await w.alice1.engine.sendMessage(w.bobId, `m${i}`)).id);
    await waitFor(async () => (await Promise.all(ids.map((id) => statusOn(w.alice1, id)))).every((s) => s === 'sent'));
    await waitForQuiet(w.server);
    const before = w.server.posts.length;

    w.bob1.engine.attach();
    w.bob2.engine.attach();
    for (const id of ids) {
      await waitFor(async () => (await statusOn(w.alice2, id)) === 'delivered', { message: 'delivered' });
    }
    await waitForQuiet(w.server);
    const delivered = w.server.posts.slice(before);
    // One drained page = one transaction = one coalesced receipt per Bob device, to Alice's two devices.
    expect(delivered.map((p) => p.senderDeviceId).sort()).toEqual([w.bob1.deviceId, w.bob2.deviceId].sort());
    for (const post of delivered) expect(post.recipientDeviceIds.sort()).toEqual([w.alice1.deviceId, w.alice2.deviceId].sort());

    // Reading on bob1: exactly one read receipt (Alice's devices + bob2); nobody answers receipts.
    expect(await w.bob1.engine.markConversationRead(w.aliceId)).toBe(5);
    for (const id of ids) await waitFor(async () => (await statusOn(w.alice1, id)) === 'read');
    await waitForQuiet(w.server);
    const reads = w.server.posts.slice(before + delivered.length);
    expect(reads).toHaveLength(1);
    expect(reads[0].senderDeviceId).toBe(w.bob1.deviceId);
    expect(reads[0].recipientDeviceIds.sort()).toEqual([w.alice1.deviceId, w.alice2.deviceId, w.bob2.deviceId].sort());
    // Marking read again changes nothing and sends nothing.
    expect(await w.bob1.engine.markConversationRead(w.aliceId)).toBe(0);
    expect(await w.bob2.engine.markConversationRead(w.aliceId)).toBe(0);
    await waitForQuiet(w.server);
    expect(w.server.posts.length).toBe(before + delivered.length + 1);
    noErrors(w);
  });
});
