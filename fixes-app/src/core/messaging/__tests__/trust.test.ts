import { json, waitFor, waitForQuiet } from '../../../test-utils';
import { generateDeviceKeyPair } from '../../crypto/deviceKeys';
import { fromBase64, toBase64 } from '../../crypto/encoding';
import { sealEnvelope } from '../../crypto/envelope';
import { generateIdentityKeyPair, signDeviceCertificate } from '../../crypto/identity';
import { randomBytes, uuidv4 } from '../../crypto/random';
import { buildMessagePayload } from '../../payloads/message';
import { buildReceiptPayload } from '../../payloads/receipt';
import { connected, createWorld, disposePhones, messageOn, messagesOf, noErrors, statusOn, trackPhone } from './world';

// Integration tests run several phones on real timers; leave room for slow machines.
jest.setTimeout(20_000);

afterEach(async () => {
  await disposePhones();
});

describe('trust (§8)', () => {
  it('an AIK change pins the new key as pending, blocks sending until Accept, still shows incoming', async () => {
    const w = await createWorld();
    const first = await w.alice1.engine.sendMessage(w.bobId, 'hello');
    await waitFor(async () => (await statusOn(w.alice1, first.id)) === 'delivered');
    const oldPin = await w.alice1.engine.getContactIdentity(w.bobId);
    expect(oldPin).toMatchObject({ pending_identity_key: null, verified: 0 });

    // Bob lost his phones: a new phone resets his identity (his other devices are revoked).
    const bob3 = trackPhone(w.server, { name: 'bob3' });
    await bob3.login('bob', w.password);
    expect(bob3.session.getState().status).toBe('needsLink');
    await bob3.session.resetIdentity(w.password);
    await connected(bob3);

    const blocked = await w.alice1.engine.sendMessage(w.bobId, 'are you there?');
    await waitFor(async () => (await statusOn(w.alice1, blocked.id)) === 'failed', { message: 'blocked send failed' });
    const pin = await w.alice1.engine.getContactIdentity(w.bobId);
    expect(pin?.identity_key).toBe(oldPin?.identity_key);
    expect(pin?.pending_identity_key).toBe(w.server.users.get(w.bobId)?.identityKey);
    const system = (await messagesOf(w.alice1, w.bobId)).filter((m) => m.direction === 'system');
    expect(system.map((m) => m.body)).toEqual(["bob's safety code changed"]);
    await expect(w.alice1.engine.sendMessage(w.bobId, 'x')).rejects.toMatchObject({ code: 'identity_pending' });
    await expect(w.alice1.engine.retryMessage(blocked.id)).rejects.toMatchObject({ code: 'identity_pending' });

    // Messages certified by the pending key are shown.
    const fromNewPhone = await bob3.engine.sendMessage(w.aliceId, 'new phone, same bob');
    await waitFor(async () => (await messageOn(w.alice1, fromNewPhone.id)) !== null, { message: 'incoming shown' });

    // Accept: the new key is pinned unverified and sending works again.
    expect(await w.alice1.engine.acceptIdentityChange(w.bobId)).toBe(true);
    expect(await w.alice1.engine.getContactIdentity(w.bobId)).toMatchObject({
      identity_key: pin?.pending_identity_key,
      pending_identity_key: null,
      verified: 0,
    });
    expect(await w.alice1.engine.retryMessage(blocked.id)).toBe(true);
    await waitFor(async () => (await messageOn(bob3, blocked.id)) !== null, { message: 'bob3 received the retry' });
    // Only one system message, even though both of Alice's devices learned about the change.
    expect((await messagesOf(w.alice1, w.bobId)).filter((m) => m.direction === 'system')).toHaveLength(1);
    noErrors({ phones: [w.alice1, w.alice2, bob3] });
  });

  it('shows messages certified by the pending key below the warning, also those drained later', async () => {
    const w = await createWorld({ secondDevices: false });
    const hello = await w.alice1.engine.sendMessage(w.bobId, 'hello');
    await waitFor(async () => (await statusOn(w.alice1, hello.id)) === 'delivered');
    const bob3 = trackPhone(w.server, { name: 'bob3' });
    await bob3.login('bob', w.password);
    await bob3.session.resetIdentity(w.password);
    await connected(bob3);

    const first = await bob3.engine.sendMessage(w.aliceId, 'new phone, same bob');
    await waitFor(async () => (await messageOn(w.alice1, first.id)) !== null, { message: 'first shown' });
    // The next one waits in the mailbox while Alice's phone is off.
    w.alice1.engine.detach();
    const second = await bob3.engine.sendMessage(w.aliceId, 'are you there?');
    await waitFor(() => w.server.pendingFor(w.alice1.deviceId).length > 0);
    w.alice1.engine.attach();
    await waitFor(async () => (await messageOn(w.alice1, second.id)) !== null, { message: 'second shown' });

    const rows = await messagesOf(w.alice1, w.bobId);
    expect(rows.map((m) => `${m.direction}:${m.body}`)).toEqual([
      'out:hello',
      "system:bob's safety code changed",
      'in:new phone, same bob',
      'in:are you there?',
    ]);
    // The messages keep their server time (§7.1); the warning moved up to them.
    expect(rows[2].sort_ts).toBe(rows[2].server_ts);
    noErrors({ phones: [w.alice1, bob3] });
  });

  it('a server that substitutes both accounts\' identity keys does not keep the devices linked', async () => {
    const w = await createWorld({ secondDevices: false });
    const realKeys = new Map<string, string>();
    for (const phone of [w.alice1, w.bob1]) realKeys.set(phone.name, toBase64((await phone.session.getIdentity())!.publicKey));
    // The server reports keys of its own for both accounts and re-signs every device under them, so
    // each side would TOFU-pin a forged key and both safety codes would be computed from forged keys.
    for (const userId of [w.aliceId, w.bobId]) {
      const forged = generateIdentityKeyPair();
      w.server.users.get(userId)!.identityKey = toBase64(forged.publicKey);
      for (const device of w.server.devicesOf(userId)) {
        device.certificate = signDeviceCertificate(forged, userId, device.id, fromBase64(device.publicKey));
      }
    }
    await w.alice1.session.refreshLinkState();
    await w.bob1.session.refreshLinkState();

    for (const [phone, peer] of [
      [w.alice1, w.bobId],
      [w.bob1, w.aliceId],
    ] as const) {
      // Not linked on the server's word: nothing is sent or pinned under the forged keys...
      expect(phone.session.getState().status).toBe('needsLink');
      expect(phone.engine.getState().status).toBe('linking');
      await expect(phone.engine.sendMessage(peer, 'secret')).rejects.toMatchObject({ code: 'not_ready' });
      expect(await phone.store.contactIdentities.get(peer)).toBeNull();
      // ...and the real AIK stays: the Security screen (this install's key vs the reported one) shows no code.
      expect(toBase64((await phone.session.getIdentity())!.publicKey)).toBe(realKeys.get(phone.name));
      expect(phone.session.getState().user?.identity_key).not.toBe(realKeys.get(phone.name));
    }
  });

  it.each(['refreshLinkState', 'devices_changed'] as const)(
    'a server that reports its own key for my account cannot add sync copies or read syncs to my history (back to ready via %s)',
    async (backToReady) => {
      const w = await createWorld({ secondDevices: false });
      const unread = await w.bob1.engine.sendMessage(w.aliceId, 'still unread');
      await waitFor(async () => (await messageOn(w.alice1, unread.id)) !== null, { message: 'alice1 received' });
      const realKey = w.server.users.get(w.aliceId)!.identityKey;
      // The server invents a key KS for Alice and a device of hers certified under it.
      const forged = generateIdentityKeyPair();
      const rogueKeys = generateDeviceKeyPair();
      const rogue = w.server.addDevice(w.aliceId, { publicKey: toBase64(rogueKeys.publicKey) });
      rogue.certificate = signDeviceCertificate(forged, w.aliceId, rogue.id, rogueKeys.publicKey);
      const inject = (payload: object) => {
        const sealed = sealEnvelope({
          payload,
          senderUserId: w.aliceId,
          senderDeviceId: rogue.id,
          senderKeys: rogueKeys,
          recipientDeviceId: w.alice1.deviceId,
          recipientPublicKey: w.alice1.session.getActiveDevice()!.keys.publicKey,
        });
        w.server.injectEnvelope({
          recipientDeviceId: w.alice1.deviceId,
          senderUserId: w.aliceId,
          senderDeviceId: rogue.id,
          nonce: toBase64(sealed.nonce),
          ciphertext: toBase64(sealed.ciphertext),
        });
      };

      // It reports KS: alice1, which holds the real AIK, goes back to "Link this device".
      w.server.users.get(w.aliceId)!.identityKey = toBase64(forged.publicKey);
      await w.alice1.session.refreshLinkState();
      expect(w.alice1.session.getState().status).toBe('needsLink');
      expect(w.alice1.engine.getState().status).toBe('linking');
      const fakeId = uuidv4();
      inject(buildMessagePayload({ id: fakeId, from: w.aliceId, to: w.bobId, body: 'I never wrote this', sentAt: Date.now() }));
      inject(buildReceiptPayload({ status: 'read', peer: w.bobId, messageIds: [unread.id], at: Date.now() }));
      await waitFor(() => w.server.pendingFor(w.alice1.deviceId).length === 0, { message: 'acked' });
      await waitForQuiet(w.server);

      // The server reports the real key again: alice1 is linked as before, its history untouched.
      w.server.users.get(w.aliceId)!.identityKey = realKey;
      if (backToReady === 'refreshLinkState') await w.alice1.session.refreshLinkState();
      else w.server.devicesChanged(w.aliceId);
      await waitFor(() => w.alice1.session.getState().status === 'ready', { message: 'ready again' });
      await waitForQuiet(w.server);
      expect(await messageOn(w.alice1, fakeId)).toBeNull();
      expect(await statusOn(w.alice1, unread.id)).toBe('received');
      expect((await w.alice1.store.conversations.get(w.bobId))?.unread_count).toBe(1);
      expect(toBase64((await w.alice1.session.getIdentity())!.publicKey)).toBe(realKey);
      noErrors(w);
    },
  );

  it('never judges my own devices under the reported key while the stored identity key is being read', async () => {
    const w = await createWorld({ secondDevices: false });
    const forged = generateIdentityKeyPair();
    const rogueKeys = generateDeviceKeyPair();
    const rogue = w.server.addDevice(w.aliceId, { publicKey: toBase64(rogueKeys.publicKey) });
    rogue.certificate = signDeviceCertificate(forged, w.aliceId, rogue.id, rogueKeys.publicKey);
    // Secure storage answers slowly (a busy keychain): the runtime's re-read of the AIK after the
    // account key changed is still running when the server pushes its envelope.
    const store = w.alice1.secureStore;
    const getItem = store.getItem.bind(store);
    jest.spyOn(store, 'getItem').mockImplementation(async (key) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return getItem(key);
    });
    w.server.users.get(w.aliceId)!.identityKey = toBase64(forged.publicKey);
    await w.alice1.session.refreshLinkState();
    expect(w.alice1.session.getState().status).toBe('needsLink');
    const fakeId = uuidv4();
    const sealed = sealEnvelope({
      payload: buildMessagePayload({ id: fakeId, from: w.aliceId, to: w.bobId, body: 'I never wrote this', sentAt: Date.now() }),
      senderUserId: w.aliceId,
      senderDeviceId: rogue.id,
      senderKeys: rogueKeys,
      recipientDeviceId: w.alice1.deviceId,
      recipientPublicKey: w.alice1.session.getActiveDevice()!.keys.publicKey,
    });
    w.server.injectEnvelope({
      recipientDeviceId: w.alice1.deviceId,
      senderUserId: w.aliceId,
      senderDeviceId: rogue.id,
      nonce: toBase64(sealed.nonce),
      ciphertext: toBase64(sealed.ciphertext),
    });
    await waitFor(() => w.server.pendingFor(w.alice1.deviceId).length === 0, { message: 'acked' });
    await waitForQuiet(w.server);
    expect(await messageOn(w.alice1, fakeId)).toBeNull();
    noErrors(w);
  });

  it('drops an envelope whose sender device the server does not know (404), with a system message', async () => {
    const w = await createWorld({ secondDevices: false });
    await w.alice1.engine.ensureConversation({ id: w.bobId, username: 'bob', avatar_url: null });
    w.server.injectEnvelope({
      recipientDeviceId: w.alice1.deviceId,
      senderUserId: w.bobId,
      senderDeviceId: uuidv4(),
      nonce: toBase64(randomBytes(24)),
      ciphertext: toBase64(randomBytes(300)),
    });
    await waitFor(() => w.server.pendingFor(w.alice1.deviceId).length === 0, { message: 'acked' });
    await waitForQuiet(w.server);
    expect(w.server.log.some((l) => l.deviceId === w.alice1.deviceId && l.status === 404)).toBe(true);
    const rows = await messagesOf(w.alice1, w.bobId);
    expect(rows.map((m) => [m.direction, m.body])).toEqual([['system', 'A message from bob could not be decrypted']]);
    noErrors(w);
  });

  it('shows a message from a reset identity on a device whose cached device list predates the reset', async () => {
    const w = await createWorld();
    // alice2 resolves bob's devices (cached for 60 s) when this message reaches it.
    const before = await w.bob1.engine.sendMessage(w.aliceId, 'before the reset');
    await waitFor(async () => (await messageOn(w.alice2, before.id)) !== null, { message: 'alice2 received' });

    const bob3 = trackPhone(w.server, { name: 'bob3' });
    await bob3.login('bob', w.password);
    await bob3.session.resetIdentity(w.password);
    await connected(bob3);

    // Found with real fixes-server e2e: the stale cache entry knew only the old key, so the new
    // device's certificate failed verification and the envelope was acked and dropped.
    const fromNewPhone = await bob3.engine.sendMessage(w.aliceId, 'new phone, same bob');
    await waitFor(async () => (await messageOn(w.alice2, fromNewPhone.id)) !== null, { message: 'shown on alice2' });
    expect(await messageOn(w.alice2, fromNewPhone.id)).toMatchObject({ direction: 'in', body: 'new phone, same bob' });
    const pin = await w.alice2.engine.getContactIdentity(w.bobId);
    expect(pin?.pending_identity_key).toBe(w.server.users.get(w.bobId)?.identityKey);
    const system = (await messagesOf(w.alice2, w.bobId)).filter((m) => m.direction === 'system');
    expect(system.map((m) => m.body)).toEqual(["bob's safety code changed"]);
    noErrors({ phones: [w.alice1, w.alice2, bob3] });
  });

  it('never encrypts to a device whose certificate does not verify under the pin', async () => {
    const w = await createWorld();
    const bogusId = uuidv4();
    // A compromised server lists an extra device for Bob with a forged certificate.
    w.server.responseFilter = (request, response) => {
      if (request.method === 'GET' && request.path === `/v1/users/${w.bobId}/devices` && response.status === 200) {
        const body = response.body as { identity_key: string; devices: unknown[] };
        const forged = {
          id: bogusId,
          public_key: toBase64(generateDeviceKeyPair().publicKey),
          certificate: toBase64(randomBytes(64)),
        };
        return json(200, { ...body, devices: [...body.devices, forged] });
      }
      return response;
    };
    const sent = await w.alice1.engine.sendMessage(w.bobId, 'not for the forged device');
    await waitFor(async () => (await statusOn(w.alice1, sent.id)) === 'delivered');
    const post = w.server.posts.find((p) => p.senderDeviceId === w.alice1.deviceId)!;
    expect(post.recipientDeviceIds.sort()).toEqual([w.bob1.deviceId, w.bob2.deviceId, w.alice2.deviceId].sort());
    expect(post.recipientDeviceIds).not.toContain(bogusId);
    noErrors(w);
  });

  it('drops envelopes from an uncertified device, with a system message in the conversation', async () => {
    const w = await createWorld({ secondDevices: false });
    await w.alice1.engine.ensureConversation({ id: w.bobId, username: 'bob', avatar_url: null });
    const rogueKeys = generateDeviceKeyPair();
    const rogue = w.server.addDevice(w.bobId, { publicKey: toBase64(rogueKeys.publicKey), certificate: null });
    const aliceKey = w.alice1.session.getActiveDevice()!.keys.publicKey;
    const messageId = uuidv4();
    const sealed = sealEnvelope({
      payload: buildMessagePayload({ id: messageId, from: w.bobId, to: w.aliceId, body: 'trust me', sentAt: Date.now() }),
      senderUserId: w.bobId,
      senderDeviceId: rogue.id,
      senderKeys: rogueKeys,
      recipientDeviceId: w.alice1.deviceId,
      recipientPublicKey: aliceKey,
    });
    w.server.injectEnvelope({
      recipientDeviceId: w.alice1.deviceId,
      senderUserId: w.bobId,
      senderDeviceId: rogue.id,
      nonce: toBase64(sealed.nonce),
      ciphertext: toBase64(sealed.ciphertext),
    });
    await waitFor(() => w.server.pendingFor(w.alice1.deviceId).length === 0, { message: 'acked' });
    await waitForQuiet(w.server);
    expect(await messageOn(w.alice1, messageId)).toBeNull();
    const rows = await messagesOf(w.alice1, w.bobId);
    expect(rows.map((m) => [m.direction, m.body])).toEqual([['system', 'A message from bob could not be decrypted']]);
    // System messages are not activity and never unread.
    expect((await w.alice1.store.conversations.get(w.bobId))?.unread_count).toBe(0);
    noErrors(w);
  });

  it('accepts an envelope from a revoked device created before the revocation', async () => {
    const w = await createWorld();
    const bob2Device = w.bob2.deviceId;
    w.server.holdFilter = (e) => e.senderDeviceId === bob2Device && e.recipientDeviceId === w.alice1.deviceId;
    const sent = await w.bob2.engine.sendMessage(w.aliceId, 'sent just before revocation');
    await waitFor(() => w.server.held.length === 1);
    w.server.advanceClock(1000);
    w.server.revoke(bob2Device);
    w.server.releaseHeld();
    await waitFor(async () => (await messageOn(w.alice1, sent.id)) !== null, { message: 'accepted' });
    expect(await messageOn(w.alice1, sent.id)).toMatchObject({ direction: 'in', status: 'received' });
    noErrors({ phones: [w.alice1, w.alice2, w.bob1] });
  });

  it('drops an envelope from a revoked device created after the revocation, with a system message', async () => {
    const w = await createWorld();
    await w.alice1.engine.ensureConversation({ id: w.bobId, username: 'bob', avatar_url: null });
    const bob2Device = w.bob2.deviceId;
    w.server.holdFilter = (e) => e.senderDeviceId === bob2Device && e.recipientDeviceId === w.alice1.deviceId;
    const sent = await w.bob2.engine.sendMessage(w.aliceId, 'replayed later');
    await waitFor(() => w.server.held.length === 1);
    const original = w.server.held[0];
    w.server.discardHeld();
    w.server.advanceClock(1000);
    w.server.revoke(bob2Device);
    // A compromised server re-dates the valid ciphertext after the revocation.
    w.server.injectEnvelope({
      recipientDeviceId: original.recipientDeviceId,
      senderUserId: original.senderUserId,
      senderDeviceId: original.senderDeviceId,
      nonce: original.nonce,
      ciphertext: original.ciphertext,
      createdAt: new Date(w.server.now() + 1000).toISOString(),
    });
    await waitFor(() => w.server.pendingFor(w.alice1.deviceId).length === 0, { message: 'acked' });
    await waitForQuiet(w.server);
    expect(await messageOn(w.alice1, sent.id)).toBeNull();
    const system = (await messagesOf(w.alice1, w.bobId)).filter((m) => m.direction === 'system');
    expect(system.map((m) => m.body)).toEqual(['A message from bob could not be decrypted']);
    noErrors({ phones: [w.alice1, w.alice2, w.bob1] });
  });
});
