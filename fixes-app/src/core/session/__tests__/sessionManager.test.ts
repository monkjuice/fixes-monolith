import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FakeFixesServer } from '../../../test-utils/fakeServer';
import { MemorySecureStore } from '../../../test-utils/memorySecureStore';
import { createNodeDatabaseOpener, type NodeDatabaseOpener } from '../../../test-utils/nodeSqlite';
import { apiError, createStubFetch } from '../../../test-utils/stubFetch';
import { ApiError, NetworkError } from '../../api/errors';
import { resolveApiConfig } from '../../config';
import { fromBase64Exact, toBase64 } from '../../crypto/encoding';
import { generateIdentityKeyPair, signDeviceCertificate, verifyDeviceCertificate } from '../../crypto/identity';
import { databaseFileName } from '../../db/files';
import { InputValidationError } from '../../utils/validation';
import { SecureItems, SecureKeys } from '../secureItems';
import { SessionManager, type SessionState } from '../sessionManager';

const config = resolveApiConfig('https://api.fixes.test', { release: true });
const PASSWORD = 'correct horse';
const tempDirs: string[] = [];

interface Install {
  manager: SessionManager;
  store: MemorySecureStore;
  items: SecureItems;
  opener: NodeDatabaseOpener;
  states: SessionState[];
}

/** One phone: its secure storage and database directory survive "app restarts" (new managers). */
function install(server: FakeFixesServer, existing?: Pick<Install, 'store' | 'opener'>): Install {
  const store = existing?.store ?? new MemorySecureStore();
  let opener = existing?.opener;
  if (!opener) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixes-session-'));
    tempDirs.push(dir);
    opener = createNodeDatabaseOpener(dir);
  }
  const manager = new SessionManager({
    config,
    secureStore: store,
    databases: opener,
    deviceName: 'Test phone',
    fetch: createStubFetch(server.handle),
    random: () => 0.5,
  });
  const states: SessionState[] = [];
  manager.subscribe((s) => states.push(s));
  return { manager, store, items: new SecureItems(store), opener, states };
}

const managers: SessionManager[] = [];
function track(i: Install): Install {
  managers.push(i.manager);
  return i;
}

afterEach(async () => {
  for (const m of managers.splice(0)) {
    m.dispose();
    try {
      await m.getLocalStore().close();
    } catch {
      // No store open for this manager; nothing to close.
    }
  }
});

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('SessionManager', () => {
  it('starts signed out on a fresh install', async () => {
    const phone = track(install(new FakeFixesServer()));
    await phone.manager.start();
    expect(phone.manager.getState()).toMatchObject({ status: 'signedOut', signedOutReason: null });
  });

  it('first device: creates the AIK, publishes it with a self-certificate and becomes ready', async () => {
    const server = new FakeFixesServer();
    const alice = server.addUser('alice', PASSWORD);
    const phone = track(install(server));
    await phone.manager.start();
    await phone.manager.login('alice', PASSWORD);

    const state = phone.manager.getState();
    expect(state.status).toBe('ready');
    expect(state.user?.identity_key).toBe(alice.identityKey);
    const identity = await phone.items.getIdentity(alice.id);
    expect(identity).not.toBeNull();
    expect(toBase64(identity!.publicKey)).toBe(alice.identityKey);
    const device = server.devicesOf(alice.id)[0];
    expect(
      verifyDeviceCertificate({
        identityPublicKey: identity!.publicKey,
        userId: alice.id,
        deviceId: device.id,
        devicePublicKey: fromBase64Exact(device.publicKey, 32),
        certificate: device.certificate,
      }),
    ).toBe(true);
    expect(server.requests).toContain('PUT /v1/users/me/identity');

    // §12.1 items: session, device key (whose public half is the registered one), DB key.
    const session = await phone.items.getSession();
    expect(session).toMatchObject({ user_id: alice.id, device_id: device.id });
    const deviceKey = await phone.items.getDeviceKey(alice.id);
    expect(toBase64(deviceKey!.keys.publicKey)).toBe(device.publicKey);
    expect(await phone.items.getDbKey(alice.id)).toMatch(/^[0-9a-f]{64}$/);
    expect(phone.opener.keysUsed.get(alice.id)).toBe(await phone.items.getDbKey(alice.id));
    expect(fs.existsSync(path.join(phone.opener.directory, databaseFileName(alice.id)))).toBe(true);
    // The local store is open and migrated.
    expect(await phone.manager.getLocalStore().conversations.listInbox()).toEqual([]);
  });

  it('generates the device key before calling login', async () => {
    const server = new FakeFixesServer();
    server.addUser('alice', PASSWORD);
    const phone = track(install(server));
    await phone.manager.start();
    let loginBody: Record<string, unknown> | null = null;
    const original = server.handle;
    const spyFetch = createStubFetch((req) => {
      if (req.path === '/v1/auth/login') loginBody = req.body as Record<string, unknown>;
      return original(req);
    });
    const manager = new SessionManager({ config, secureStore: phone.store, databases: phone.opener, deviceName: 'x', fetch: spyFetch });
    managers.push(manager);
    await manager.login('alice', PASSWORD);
    const device = (loginBody as unknown as { device: { public_key: string } }).device;
    expect(fromBase64Exact(device.public_key, 32)).toHaveLength(32);
    const stored = await phone.items.getDeviceKey(manager.getState().user!.id);
    expect(toBase64(stored!.keys.publicKey)).toBe(device.public_key);
  });

  it('re-login on the same install self-certifies with the stored AIK', async () => {
    const server = new FakeFixesServer();
    const alice = server.addUser('alice', PASSWORD);
    const phone = track(install(server));
    await phone.manager.start();
    await phone.manager.login('alice', PASSWORD);
    await phone.manager.logout();
    expect(phone.manager.getState()).toMatchObject({ status: 'signedOut', signedOutReason: 'logout' });
    server.requests.length = 0;

    await phone.manager.login('alice', PASSWORD);
    expect(phone.manager.getState().status).toBe('ready');
    expect(server.requests).not.toContain('PUT /v1/users/me/identity');
    const current = server.devicesOf(alice.id).find((d) => !d.revoked)!;
    expect(server.requests).toContain(`PUT /v1/devices/${current.id}/certificate`);
    expect(phone.manager.getState().device?.certificate).toBe(current.certificate);
  });

  it('a device of an account whose AIK lives elsewhere needs linking', async () => {
    const server = new FakeFixesServer();
    const otherDeviceIdentity = generateIdentityKeyPair();
    server.addUser('alice', PASSWORD, toBase64(otherDeviceIdentity.publicKey));
    const phone = track(install(server));
    await phone.manager.start();
    await phone.manager.login('alice', PASSWORD);
    expect(phone.manager.getState()).toMatchObject({ status: 'needsLink' });
    expect(phone.manager.getState().device?.certificate).toBeNull();
    expect(server.requests.filter((r) => r.startsWith('PUT'))).toEqual([]);
    // The DB is open already (the link QR transfer state lives there).
    expect(phone.manager.getLocalStore()).toBeDefined();
  });

  it('a stale local AIK that does not match the server is not used', async () => {
    const server = new FakeFixesServer();
    const alice = server.addUser('alice', PASSWORD, toBase64(generateIdentityKeyPair().publicKey));
    const phone = track(install(server));
    await phone.items.setIdentity(alice.id, generateIdentityKeyPair());
    await phone.manager.start();
    await phone.manager.login('alice', PASSWORD);
    expect(phone.manager.getState().status).toBe('needsLink');
  });

  it('becomes ready once another device certifies it (refreshLinkState)', async () => {
    const server = new FakeFixesServer();
    const aik = generateIdentityKeyPair();
    const alice = server.addUser('alice', PASSWORD, toBase64(aik.publicKey));
    const phone = track(install(server));
    await phone.manager.start();
    await phone.manager.login('alice', PASSWORD);
    const device = server.devicesOf(alice.id)[0];
    device.certificate = signDeviceCertificate(aik, alice.id, device.id, fromBase64Exact(device.publicKey, 32));
    await phone.manager.refreshLinkState();
    expect(phone.manager.getState().status).toBe('ready');
    // The AIK arrives later in the link transfer; adoptIdentity only accepts the account's key.
    await expect(phone.manager.adoptIdentity(generateIdentityKeyPair())).rejects.toThrow(/not the account identity key/);
    await phone.manager.adoptIdentity(aik);
    expect(toBase64((await phone.manager.getIdentity())!.publicKey)).toBe(alice.identityKey);
  });

  it('handles losing the race to create the identity', async () => {
    const server = new FakeFixesServer();
    const alice = server.addUser('alice', PASSWORD);
    const phone = track(install(server));
    await phone.manager.start();
    const original = server.handle;
    const racing = createStubFetch((req) => {
      // Another device publishes its AIK between our login and our PUT.
      if (req.path === '/v1/users/me/identity') alice.identityKey = toBase64(generateIdentityKeyPair().publicKey);
      return original(req);
    });
    const manager = new SessionManager({ config, secureStore: phone.store, databases: phone.opener, deviceName: 'x', fetch: racing });
    managers.push(manager);
    await manager.login('alice', PASSWORD);
    expect(manager.getState().status).toBe('needsLink');
    // The key generated for the lost race is not left behind (it would block the link transfer).
    expect(await manager.getIdentity()).toBeNull();
  });

  it('a local AIK that differs from the account key keeps the device unlinked, even when certified under the server key', async () => {
    const server = new FakeFixesServer();
    const serverKey = generateIdentityKeyPair();
    const alice = server.addUser('alice', PASSWORD, toBase64(serverKey.publicKey));
    const phone = track(install(server));
    const local = generateIdentityKeyPair();
    await phone.items.setIdentity(alice.id, local);
    await phone.manager.start();
    await phone.manager.login('alice', PASSWORD);
    expect(phone.manager.getState().status).toBe('needsLink');

    // The server (honest after an identity reset elsewhere, or substituting its own key) certifies this
    // device under the key it reports. That proves nothing while this install holds another AIK.
    const device = server.devicesOf(alice.id)[0];
    device.certificate = signDeviceCertificate(serverKey, alice.id, device.id, fromBase64Exact(device.publicKey, 32));
    await phone.manager.refreshLinkState();
    expect(phone.manager.getState().status).toBe('needsLink');
    expect(phone.states.some((s) => s.status === 'ready')).toBe(false);
    expect(toBase64((await phone.manager.getIdentity())!.publicKey)).toBe(toBase64(local.publicKey));

    // The link transfer brings the account key (checked against the server's): then it is linked.
    await phone.manager.adoptIdentity(serverKey);
    await phone.manager.refreshLinkState();
    expect(phone.manager.getState().status).toBe('ready');
  });

  it('an account without an identity key gets the AIK this install holds back, never a new one', async () => {
    const server = new FakeFixesServer();
    // E.g. a server restored from a backup taken before the identity was published.
    const alice = server.addUser('alice', PASSWORD);
    const phone = track(install(server));
    const held = generateIdentityKeyPair();
    await phone.items.setIdentity(alice.id, held);
    await phone.manager.start();
    let published: unknown = null;
    const original = server.handle;
    const spying = createStubFetch((req) => {
      if (req.method === 'PUT' && req.path === '/v1/users/me/identity') published = (req.body as { identity_key: string }).identity_key;
      return original(req);
    });
    const manager = new SessionManager({ config, secureStore: phone.store, databases: phone.opener, deviceName: 'x', fetch: spying });
    managers.push(manager);
    await manager.login('alice', PASSWORD);
    expect(manager.getState().status).toBe('ready');
    expect(published).toBe(toBase64(held.publicKey));
    expect(alice.identityKey).toBe(toBase64(held.publicKey));
    expect(toBase64((await manager.getIdentity())!.publicKey)).toBe(toBase64(held.publicKey));
  });

  it('is not linked when the server reports another key than the one this device just published', async () => {
    const server = new FakeFixesServer();
    server.addUser('alice', PASSWORD);
    const phone = track(install(server));
    await phone.manager.start();
    const original = server.handle;
    const substituting = createStubFetch(async (req) => {
      const response = await original(req);
      if (req.method === 'PUT' && req.path === '/v1/users/me/identity' && response.status === 200) {
        const body = response.body as { user: Record<string, unknown> };
        return { ...response, body: { user: { ...body.user, identity_key: toBase64(generateIdentityKeyPair().publicKey) } } };
      }
      return response;
    });
    const manager = new SessionManager({ config, secureStore: phone.store, databases: phone.opener, deviceName: 'x', fetch: substituting });
    managers.push(manager);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await manager.login('alice', PASSWORD);
    error.mockRestore();
    expect(manager.getState()).toMatchObject({ status: 'loading', error: expect.stringMatching(/another identity key/) });
  });

  it('restores the session on launch, rotating and persisting the refresh token', async () => {
    const server = new FakeFixesServer();
    server.addUser('alice', PASSWORD);
    const phone = track(install(server));
    await phone.manager.start();
    await phone.manager.login('alice', PASSWORD);
    const before = (await phone.items.getSession())!.refresh_token;
    phone.manager.dispose();
    await phone.manager.getLocalStore().close();

    const relaunch = track(install(server, phone));
    await relaunch.manager.start();
    expect(relaunch.manager.getState().status).toBe('ready');
    expect(relaunch.states[0].status).toBe('loading');
    const after = (await phone.items.getSession())!.refresh_token;
    expect(after).not.toBe(before);
    expect(server.requests).toContain('POST /v1/auth/refresh');
  });

  it('restore of a revoked device signs out but keeps local data', async () => {
    const server = new FakeFixesServer();
    const alice = server.addUser('alice', PASSWORD);
    const phone = track(install(server));
    await phone.manager.start();
    await phone.manager.login('alice', PASSWORD);
    phone.manager.dispose();
    await phone.manager.getLocalStore().close();
    server.revoke(server.devicesOf(alice.id)[0].id);

    const relaunch = track(install(server, phone));
    await relaunch.manager.start();
    expect(relaunch.manager.getState()).toMatchObject({ status: 'signedOut', signedOutReason: 'invalid_refresh_token' });
    expect(phone.store.items.has(SecureKeys.session)).toBe(false);
    expect(phone.store.items.has(SecureKeys.device(alice.id))).toBe(false);
    expect(phone.store.items.has(SecureKeys.identity(alice.id))).toBe(true);
    expect(phone.store.items.has(SecureKeys.dbKey(alice.id))).toBe(true);
  });

  it('device revoked while running: the signed-out event ends the session', async () => {
    const server = new FakeFixesServer();
    const alice = server.addUser('alice', PASSWORD);
    const phone = track(install(server));
    await phone.manager.start();
    await phone.manager.login('alice', PASSWORD);
    server.revoke(server.devicesOf(alice.id)[0].id);
    await expect(phone.manager.api.listMyDevices()).rejects.toMatchObject({ code: 'device_revoked' });
    await waitFor(() => phone.manager.getState().status === 'signedOut');
    expect(phone.manager.getState().signedOutReason).toBe('device_revoked');
    expect(phone.store.items.has(SecureKeys.session)).toBe(false);
    expect(phone.store.items.has(SecureKeys.dbKey(alice.id))).toBe(true);
    expect(() => phone.manager.getLocalStore()).toThrow();
  });

  it('restore while offline waits in loading/offline and recovers on retry', async () => {
    const server = new FakeFixesServer();
    server.addUser('alice', PASSWORD);
    const phone = track(install(server));
    await phone.manager.start();
    await phone.manager.login('alice', PASSWORD);
    phone.manager.dispose();
    await phone.manager.getLocalStore().close();

    server.offline = true;
    const relaunch = track(install(server, phone));
    await relaunch.manager.start();
    expect(relaunch.manager.getState()).toMatchObject({ status: 'loading', offline: true });
    server.offline = false;
    await relaunch.manager.retry();
    expect(relaunch.manager.getState()).toMatchObject({ status: 'ready', offline: false });
  });

  it('logout runs the drain/flush hooks first, revokes the device and keeps local data', async () => {
    const server = new FakeFixesServer();
    const alice = server.addUser('alice', PASSWORD);
    const phone = track(install(server));
    await phone.manager.start();
    await phone.manager.login('alice', PASSWORD);
    const order: string[] = [];
    phone.manager.addLogoutHook(async () => {
      order.push(`hook (requests so far: ${server.requests.includes('POST /v1/auth/logout')})`);
    });
    await phone.manager.logout();
    expect(order).toEqual(['hook (requests so far: false)']);
    expect(server.devicesOf(alice.id)[0].revoked).toBe(true);
    expect(phone.store.items.has(SecureKeys.session)).toBe(false);
    expect(phone.store.items.has(SecureKeys.device(alice.id))).toBe(false);
    expect(phone.store.items.has(SecureKeys.identity(alice.id))).toBe(true);
    expect(phone.store.items.has(SecureKeys.dbKey(alice.id))).toBe(true);
    expect(fs.existsSync(path.join(phone.opener.directory, databaseFileName(alice.id)))).toBe(true);
  });

  it('logout requires connectivity and leaves the session intact when offline', async () => {
    const server = new FakeFixesServer();
    server.addUser('alice', PASSWORD);
    const phone = track(install(server));
    await phone.manager.start();
    await phone.manager.login('alice', PASSWORD);
    server.offline = true;
    await expect(phone.manager.logout()).rejects.toBeInstanceOf(NetworkError);
    expect(phone.manager.getState().status).toBe('ready');
    expect(phone.store.items.has(SecureKeys.session)).toBe(true);
  });

  it('a failing logout hook aborts the logout', async () => {
    const server = new FakeFixesServer();
    const alice = server.addUser('alice', PASSWORD);
    const phone = track(install(server));
    await phone.manager.start();
    await phone.manager.login('alice', PASSWORD);
    phone.manager.addLogoutHook(async () => {
      throw new Error('mailbox not drained');
    });
    await expect(phone.manager.logout()).rejects.toThrow('mailbox not drained');
    expect(server.devicesOf(alice.id)[0].revoked).toBe(false);
    expect(phone.manager.getState().status).toBe('ready');
  });

  it('erase deletes the database and every secure item of the user', async () => {
    const server = new FakeFixesServer();
    const alice = server.addUser('alice', PASSWORD);
    const phone = track(install(server));
    await phone.manager.start();
    await phone.manager.login('alice', PASSWORD);
    await phone.items.setBackupKey(alice.id, '0000-0000-0000-0000-0000-0000');
    const result = await phone.manager.eraseDevice();
    expect(result).toEqual({ serverRevoked: true });
    expect(phone.manager.getState()).toMatchObject({ status: 'signedOut', signedOutReason: 'erased' });
    expect([...phone.store.items.keys()]).toEqual([]);
    expect(fs.readdirSync(phone.opener.directory)).toEqual([]);
  });

  it('erase works offline and reports that the server was not told', async () => {
    const server = new FakeFixesServer();
    server.addUser('alice', PASSWORD);
    const phone = track(install(server));
    await phone.manager.start();
    await phone.manager.login('alice', PASSWORD);
    server.offline = true;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(phone.manager.eraseDevice()).resolves.toEqual({ serverRevoked: false });
    warn.mockRestore();
    expect([...phone.store.items.keys()]).toEqual([]);
  });

  it('reset identity from needsLink: new AIK, certified device, ready', async () => {
    const server = new FakeFixesServer();
    const oldKey = toBase64(generateIdentityKeyPair().publicKey);
    const alice = server.addUser('alice', PASSWORD, oldKey);
    const phone = track(install(server));
    await phone.manager.start();
    await phone.manager.login('alice', PASSWORD);
    expect(phone.manager.getState().status).toBe('needsLink');

    await expect(phone.manager.resetIdentity('wrong password')).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(await phone.items.getIdentity(alice.id)).toBeNull(); // rejected reset leaves nothing behind
    expect(alice.identityKey).toBe(oldKey);

    await phone.manager.resetIdentity(PASSWORD);
    expect(phone.manager.getState().status).toBe('ready');
    expect(alice.identityKey).not.toBe(oldKey);
    expect(toBase64((await phone.items.getIdentity(alice.id))!.publicKey)).toBe(alice.identityKey);
  });

  it('an identity reset whose answer was lost is re-checked quietly: ready when the server applied it', async () => {
    const server = new FakeFixesServer();
    const oldKey = toBase64(generateIdentityKeyPair().publicKey);
    const alice = server.addUser('alice', PASSWORD, oldKey);
    const phone = track(install(server));
    await phone.manager.start();
    await phone.manager.login('alice', PASSWORD);
    expect(phone.manager.getState().status).toBe('needsLink');
    // The server applies the reset, but its answer is lost (and with no socket, so is devices_changed).
    server.responseFilter = (req, response) => {
      if (req.path === '/v1/auth/reset-identity') throw new TypeError('Network request failed');
      return response;
    };
    await expect(phone.manager.resetIdentity(PASSWORD)).rejects.toBeInstanceOf(NetworkError);
    server.responseFilter = null;
    expect(alice.identityKey).not.toBe(oldKey);
    expect(toBase64((await phone.items.getIdentity(alice.id))!.publicKey)).toBe(alice.identityKey);
    expect(phone.manager.getState().status).toBe('needsLink');

    await waitFor(() => phone.manager.getState().status === 'ready', 5000);
    expect(phone.manager.getState().user?.identity_key).toBe(alice.identityKey);
  });

  it('a retap after a lost reset answer does not rotate the account key again', async () => {
    const server = new FakeFixesServer();
    const oldKey = toBase64(generateIdentityKeyPair().publicKey);
    const alice = server.addUser('alice', PASSWORD, oldKey);
    const phone = track(install(server));
    await phone.manager.start();
    await phone.manager.login('alice', PASSWORD);
    server.responseFilter = (req, response) => {
      if (req.path === '/v1/auth/reset-identity') throw new TypeError('Network request failed');
      return response;
    };
    await expect(phone.manager.resetIdentity(PASSWORD)).rejects.toBeInstanceOf(NetworkError);
    server.responseFilter = null;
    const applied = alice.identityKey;
    expect(applied).not.toBe(oldKey);

    // The panel shows the network error and the user tries again at once, before any quiet re-check: a
    // mistyped password first (the key of the unknown attempt stays), then the right one.
    await expect(phone.manager.resetIdentity('wrong password')).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(toBase64((await phone.items.getIdentity(alice.id))!.publicKey)).toBe(applied);
    await phone.manager.resetIdentity(PASSWORD);
    expect(alice.identityKey).toBe(applied);
    expect(phone.manager.getState()).toMatchObject({ status: 'ready', user: { identity_key: applied } });
    expect(toBase64((await phone.items.getIdentity(alice.id))!.publicKey)).toBe(applied);
  });

  it('an offline retap keeps the key of the unknown attempt, so the quiet re-check finds it applied', async () => {
    const server = new FakeFixesServer();
    const oldKey = toBase64(generateIdentityKeyPair().publicKey);
    const alice = server.addUser('alice', PASSWORD, oldKey);
    const phone = track(install(server));
    await phone.manager.start();
    await phone.manager.login('alice', PASSWORD);
    // The server applies the reset, then the network goes down before the answer arrives.
    server.responseFilter = (req, response) => {
      if (req.path === '/v1/auth/reset-identity') {
        server.offline = true;
        throw new TypeError('Network request failed');
      }
      return response;
    };
    await expect(phone.manager.resetIdentity(PASSWORD)).rejects.toBeInstanceOf(NetworkError);
    server.responseFilter = null;
    const applied = alice.identityKey;
    expect(applied).not.toBe(oldKey);

    await expect(phone.manager.resetIdentity(PASSWORD)).rejects.toBeInstanceOf(NetworkError);
    // The secret of the key the server holds is still on this phone.
    expect(toBase64((await phone.items.getIdentity(alice.id))!.publicKey)).toBe(applied);
    server.offline = false;
    await waitFor(() => phone.manager.getState().status === 'ready', 5000);
    expect(alice.identityKey).toBe(applied);
    expect(server.requests.filter((r) => r === 'POST /v1/auth/reset-identity')).toHaveLength(1);
  }, 10_000);

  it('an identity reset that never reached the server stays unlinked after one quiet re-check', async () => {
    const server = new FakeFixesServer();
    const oldKey = toBase64(generateIdentityKeyPair().publicKey);
    const alice = server.addUser('alice', PASSWORD, oldKey);
    const phone = track(install(server));
    await phone.manager.start();
    await phone.manager.login('alice', PASSWORD);
    server.interceptor = (req) => {
      if (req.path === '/v1/auth/reset-identity') throw new TypeError('Network request failed');
      return undefined;
    };
    await expect(phone.manager.resetIdentity(PASSWORD)).rejects.toBeInstanceOf(NetworkError);
    server.interceptor = null;
    const accountChecks = () => server.requests.filter((r) => r === 'GET /v1/users/me').length;
    const before = accountChecks();
    await waitFor(() => accountChecks() > before, 5000);
    // The re-check found the old key: no further retries (the next would come after about 2 s).
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(accountChecks()).toBe(before + 1);
    expect(alice.identityKey).toBe(oldKey);
    expect(phone.manager.getState()).toMatchObject({ status: 'needsLink', error: null });

    // Trying again then works: one rotation away from the old key, and this phone holds the new one.
    await phone.manager.resetIdentity(PASSWORD);
    expect(alice.identityKey).not.toBe(oldKey);
    expect(phone.manager.getState().status).toBe('ready');
    expect(toBase64((await phone.items.getIdentity(alice.id))!.publicKey)).toBe(alice.identityKey);
  });

  it('refreshLinkState keeps a ready session ready when the server cannot be reached or refuses', async () => {
    const server = new FakeFixesServer();
    server.addUser('alice', PASSWORD);
    const phone = track(install(server));
    await phone.manager.start();
    await phone.manager.login('alice', PASSWORD);
    const before = phone.manager.getState();
    expect(before.status).toBe('ready');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      server.offline = true;
      await phone.manager.refreshLinkState();
      server.offline = false;
      server.interceptor = (req) =>
        req.method === 'GET' && req.path === '/v1/users/me' ? { ...apiError(429, 'rate_limited'), headers: { 'Retry-After': '1' } } : undefined;
      await phone.manager.refreshLinkState();
    } finally {
      warn.mockRestore();
    }
    // Never back to the startup state (Splash), and the store stays open.
    expect(phone.states.slice(phone.states.indexOf(before)).map((s) => s.status)).not.toContain('loading');
    expect(phone.manager.getState()).toMatchObject({ status: 'ready', user: before.user, device: before.device });
    expect(phone.manager.getLocalStore()).toBeDefined();
  });

  it('refreshLinkState while not linked keeps needsLink on failure and retries quietly', async () => {
    const server = new FakeFixesServer();
    const aik = generateIdentityKeyPair();
    const alice = server.addUser('alice', PASSWORD, toBase64(aik.publicKey));
    const phone = track(install(server));
    await phone.manager.start();
    await phone.manager.login('alice', PASSWORD);
    expect(phone.manager.getState().status).toBe('needsLink');
    // Another device certifies this one, but the re-check that follows fails once.
    const device = server.devicesOf(alice.id)[0];
    device.certificate = signDeviceCertificate(aik, alice.id, device.id, fromBase64Exact(device.publicKey, 32));
    let failures = 0;
    server.interceptor = (req) => {
      if (req.method === 'GET' && req.path === '/v1/users/me' && failures === 0) {
        failures++;
        return apiError(400, 'validation_error');
      }
      return undefined;
    };
    const since = phone.states.length;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await phone.manager.refreshLinkState();
      expect(failures).toBe(1);
      expect(phone.manager.getState()).toMatchObject({ status: 'needsLink', error: null });
      // The quiet retry (backoff ≈ 1 s) finds the certificate.
      await waitFor(() => phone.manager.getState().status === 'ready', 5000);
    } finally {
      warn.mockRestore();
    }
    expect(phone.states.slice(since).map((s) => s.status)).toEqual(['ready']);
  });

  it('updateUser takes a new avatar into the state of a ready session (never the identity key)', async () => {
    const server = new FakeFixesServer();
    const alice = server.addUser('alice', PASSWORD);
    const phone = track(install(server));
    await phone.manager.start();
    await phone.manager.login('alice', PASSWORD);
    const user = phone.manager.getState().user!;
    const avatar = 'https://media.fixes.test/avatars/new.jpg';
    await phone.manager.updateUser({ ...user, avatar_url: avatar, identity_key: toBase64(generateIdentityKeyPair().publicKey) });
    expect(phone.manager.getState().user).toEqual({ ...user, avatar_url: avatar });
    // Another account's data is ignored.
    await phone.manager.updateUser({ id: server.addUser('bob', PASSWORD).id, username: 'bob', avatar_url: null, identity_key: null });
    expect(phone.manager.getState().user).toEqual({ ...user, avatar_url: avatar });
    expect(phone.manager.getState().user?.id).toBe(alice.id);
  });

  it('moves a database file aside when its key is missing (restored OS backup)', async () => {
    const server = new FakeFixesServer();
    const alice = server.addUser('alice', PASSWORD);
    const phone = install(server);
    fs.writeFileSync(path.join(phone.opener.directory, databaseFileName(alice.id)), 'ciphertext from a backup');
    track(phone);
    await phone.manager.start();
    await phone.manager.login('alice', PASSWORD);
    expect(phone.manager.getState()).toMatchObject({ status: 'ready', localDataReset: true });
    const files = fs.readdirSync(phone.opener.directory);
    expect(files.some((f) => f.startsWith(`${databaseFileName(alice.id)}.orphaned-`))).toBe(true);
    expect(await phone.manager.getLocalStore().conversations.listInbox()).toEqual([]);
  });

  it('validates credentials locally and propagates login errors', async () => {
    const server = new FakeFixesServer();
    server.addUser('alice', PASSWORD);
    const phone = track(install(server));
    await phone.manager.start();
    await expect(phone.manager.login('a', PASSWORD)).rejects.toBeInstanceOf(InputValidationError);
    await expect(phone.manager.register('alice', 'short')).rejects.toBeInstanceOf(InputValidationError);
    await expect(phone.manager.login('alice', 'wrong password')).rejects.toBeInstanceOf(ApiError);
    expect(phone.manager.getState().status).toBe('signedOut');
    expect(phone.store.items.size).toBe(0);
    const user = await phone.manager.register('bob_2', PASSWORD);
    expect(user.username).toBe('bob_2');
  });

  it('refuses to start without a working random number generator', async () => {
    const phone = track(install(new FakeFixesServer()));
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', { value: { getRandomValues: (a: Uint8Array) => a }, configurable: true });
    try {
      await expect(phone.manager.start()).rejects.toThrow(/self-test/);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
    }
  });
});
