import { MemorySecureStore } from '../../../test-utils/memorySecureStore';
import { generateDeviceKeyPair } from '../../crypto/deviceKeys';
import { generateIdentityKeyPair } from '../../crypto/identity';
import { uuidv4 } from '../../crypto/random';
import { CorruptSecureItemError, SecureItems, SecureKeys, SessionRefreshTokenStore } from '../secureItems';

describe('secure storage items (§12.1)', () => {
  const userId = uuidv4();
  const deviceId = uuidv4();

  it('uses the documented key names', () => {
    expect(SecureKeys.session).toBe('fixes.session');
    expect(SecureKeys.device(userId)).toBe(`fixes.device.${userId}`);
    expect(SecureKeys.identity(userId)).toBe(`fixes.identity.${userId}`);
    expect(SecureKeys.dbKey(userId)).toBe(`fixes.dbkey.${userId}`);
    expect(SecureKeys.backupKey(userId)).toBe(`fixes.backupkey.${userId}`);
  });

  it('stores the documented shapes', async () => {
    const store = new MemorySecureStore();
    const items = new SecureItems(store);
    const device = generateDeviceKeyPair();
    const identity = generateIdentityKeyPair();
    await items.setSession({ user_id: userId, device_id: deviceId, refresh_token: 'r' });
    await items.setDeviceKey(userId, deviceId, device);
    await items.setIdentity(userId, identity);
    expect(JSON.parse(store.items.get('fixes.session')!)).toEqual({ user_id: userId, device_id: deviceId, refresh_token: 'r' });
    expect(Object.keys(JSON.parse(store.items.get(SecureKeys.device(userId))!)).sort()).toEqual(['device_id', 'public_key', 'secret_key']);
    expect(Object.keys(JSON.parse(store.items.get(SecureKeys.identity(userId))!)).sort()).toEqual(['public_key', 'secret_key']);
    expect((await items.getDeviceKey(userId))?.keys).toEqual(device);
    expect(await items.getIdentity(userId)).toEqual(identity);
  });

  it('detects corrupt or mismatched items', async () => {
    const store = new MemorySecureStore();
    const items = new SecureItems(store);
    await store.setItem('fixes.session', '{not json');
    await expect(items.getSession()).rejects.toBeInstanceOf(CorruptSecureItemError);
    const a = generateIdentityKeyPair();
    const b = generateIdentityKeyPair();
    await store.setItem(
      SecureKeys.identity(userId),
      JSON.stringify({ public_key: Buffer.from(a.publicKey).toString('base64'), secret_key: Buffer.from(b.secretKey).toString('base64') }),
    );
    await expect(items.getIdentity(userId)).rejects.toBeInstanceOf(CorruptSecureItemError);
    await store.setItem(SecureKeys.dbKey(userId), 'XYZ');
    await expect(items.getDbKey(userId)).rejects.toBeInstanceOf(CorruptSecureItemError);
  });

  it('never builds keys from non-UUID user ids', async () => {
    const items = new SecureItems(new MemorySecureStore());
    await expect(async () => items.getIdentity('../../etc')).rejects.toThrow(RangeError);
  });

  it('erase removes every item of the user and only their session', async () => {
    const store = new MemorySecureStore();
    const items = new SecureItems(store);
    const other = uuidv4();
    await items.setSession({ user_id: userId, device_id: deviceId, refresh_token: 'r' });
    await items.setDeviceKey(userId, deviceId, generateDeviceKeyPair());
    await items.setIdentity(userId, generateIdentityKeyPair());
    await items.setDbKey(userId, 'ab'.repeat(32));
    await items.setBackupKey(userId, '0000-0000-0000-0000-0000-0000');
    await items.setDbKey(other, 'cd'.repeat(32));
    await items.deleteAllForUser(userId);
    expect([...store.items.keys()]).toEqual([SecureKeys.dbKey(other)]);
  });

  it('the refresh token store rewrites only the token', async () => {
    const items = new SecureItems(new MemorySecureStore());
    const tokens = new SessionRefreshTokenStore(items);
    await expect(tokens.setRefreshToken('x')).rejects.toThrow(/No session/);
    await items.setSession({ user_id: userId, device_id: deviceId, refresh_token: 'old' });
    await tokens.setRefreshToken('new');
    expect(await items.getSession()).toEqual({ user_id: userId, device_id: deviceId, refresh_token: 'new' });
    expect(await tokens.getRefreshToken()).toBe('new');
  });
});
