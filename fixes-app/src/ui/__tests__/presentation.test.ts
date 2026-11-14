import type { FriendRequest, MyDevice, User } from '../../core/api/types';
import { toBase64 } from '../../core/crypto/encoding';
import { generateIdentityKeyPair, signDeviceCertificate } from '../../core/crypto/identity';
import { generateDeviceKeyPair } from '../../core/crypto/deviceKeys';
import { IDLE_OUTGOING_LINK } from '../../core/linking/outgoing';
import { AVATAR_MAX_SIDE, avatarPlan } from '../presentation/avatarImage';
import { deviceViews, isDeviceLinked } from '../presentation/devices';
import { friendshipWith } from '../presentation/friendship';
import { isOutgoingLinkRunning, outgoingLinkProgress, outgoingLinkText } from '../presentation/linkProgress';
import { hasPasswordErrors, validatePasswordChange } from '../presentation/passwordChange';
import { SEARCH_RULE, validateSearchInput } from '../presentation/search';

const ME = '11111111-1111-4111-8111-111111111111';
const BOB: User = { id: '22222222-2222-4222-8222-222222222222', username: 'bob', avatar_url: null };
const ME_USER: User = { id: ME, username: 'alice', avatar_url: null };

describe('Discover search validation (§14: [A-Za-z0-9_]{1,30} before calling the server)', () => {
  it.each(['a', 'bob', 'Bob_99', '_', 'x'.repeat(30), '  bob  '])('accepts %p', (text) => {
    expect(validateSearchInput(text)).toEqual({ ok: true, query: text.trim() });
  });

  it.each(['', '   ', 'x'.repeat(31), 'bob smith', 'bob-smith', 'bob.smith', 'bób', 'bob%', '*', 'a\nb', '😀'])(
    'refuses %p',
    (text) => {
      expect(validateSearchInput(text)).toEqual({ ok: false, error: SEARCH_RULE });
    },
  );
});

function request(id: string, from: User, to: User): FriendRequest {
  return { id, from_user: from, to_user: to, created_at: '2026-01-01T00:00:00.000Z' };
}

describe('friendship state (§14 profile buttons)', () => {
  const none = { incoming: [], outgoing: [] };

  it('is self, friends, received, sent or none', () => {
    expect(friendshipWith(ME, ME, [], none)).toEqual({ kind: 'self' });
    expect(friendshipWith(ME, BOB.id, [BOB], none)).toEqual({ kind: 'friends' });
    expect(friendshipWith(ME, BOB.id, [], { incoming: [request('r1', BOB, ME_USER)], outgoing: [] })).toEqual({
      kind: 'requestReceived',
      requestId: 'r1',
    });
    expect(friendshipWith(ME, BOB.id, [], { incoming: [], outgoing: [request('r2', ME_USER, BOB)] })).toEqual({
      kind: 'requestSent',
      requestId: 'r2',
    });
    expect(friendshipWith(ME, BOB.id, [], none)).toEqual({ kind: 'none' });
  });

  it('prefers the friendship over a leftover request', () => {
    expect(friendshipWith(ME, BOB.id, [BOB], { incoming: [request('r1', BOB, ME_USER)], outgoing: [] })).toEqual({ kind: 'friends' });
  });
});

describe('devices (§8 "Not linked", new devices)', () => {
  const identity = generateIdentityKeyPair();
  const identityKey = toBase64(identity.publicKey);
  const now = Date.parse('2026-06-10T12:00:00.000Z');

  function device(id: string, options: { certified: boolean; current?: boolean; created: string; seen?: string; name?: string }): MyDevice {
    const keys = generateDeviceKeyPair();
    return {
      id,
      name: options.name ?? id,
      public_key: toBase64(keys.publicKey),
      certificate: options.certified ? signDeviceCertificate(identity, ME, id, keys.publicKey) : null,
      created_at: options.created,
      last_seen_at: options.seen ?? options.created,
      current: options.current ?? false,
    };
  }

  it('checks certificates against the account identity key itself', () => {
    const linked = device('a', { certified: true, created: '2026-06-01T00:00:00.000Z' });
    expect(isDeviceLinked(linked, ME, identityKey)).toBe(true);
    expect(isDeviceLinked(linked, ME, toBase64(generateIdentityKeyPair().publicKey))).toBe(false);
    expect(isDeviceLinked({ ...linked, id: 'b' }, ME, identityKey)).toBe(false);
    expect(isDeviceLinked({ ...linked, certificate: 'not base64!' }, ME, identityKey)).toBe(false);
    expect(isDeviceLinked(linked, ME, null)).toBe(false);
  });

  it('puts this device first, labels each, and flags devices added after this one within a week', () => {
    const views = deviceViews(
      [
        device('old', { certified: true, created: '2026-01-01T00:00:00.000Z', seen: '2026-06-10T11:00:00.000Z' }),
        device('fresh', { certified: false, created: '2026-06-09T00:00:00.000Z', seen: '2026-06-10T11:59:00.000Z' }),
        device('me', { certified: true, current: true, created: '2026-05-01T00:00:00.000Z' }),
      ],
      { userId: ME, identityKey },
      now,
    );
    expect(views.map((v) => [v.device.id, v.status, v.isNew])).toEqual([
      ['me', 'This device', false],
      ['fresh', 'Not linked', true],
      ['old', 'Linked', false],
    ]);
    expect(views[1].lastSeen).toBe('Last seen a minute ago');
  });
});

describe('avatar plan (§14: square crop, ≤ 1024 px)', () => {
  it('crops the centre square and only ever scales down', () => {
    expect(avatarPlan(4000, 3000)).toEqual({ crop: { originX: 500, originY: 0, width: 3000, height: 3000 }, resizeTo: AVATAR_MAX_SIDE });
    expect(avatarPlan(600, 900)).toEqual({ crop: { originX: 0, originY: 150, width: 600, height: 600 }, resizeTo: null });
    expect(avatarPlan(2048, 2048)).toEqual({ crop: null, resizeTo: AVATAR_MAX_SIDE });
    expect(avatarPlan(512, 512)).toEqual({ crop: null, resizeTo: null });
    expect(() => avatarPlan(0, 10)).toThrow(RangeError);
  });
});

describe('link progress texts', () => {
  it('describes each phase and counts history chunks', () => {
    expect(isOutgoingLinkRunning('sendingHistory')).toBe(true);
    expect(isOutgoingLinkRunning('done')).toBe(false);
    const sending = { ...IDLE_OUTGOING_LINK, phase: 'sendingHistory' as const, sentChunks: 2, totalChunks: 4 };
    expect(outgoingLinkText(sending)).toBe('Sending your history… 2 of 4');
    expect(outgoingLinkProgress(sending)).toBeCloseTo(0.55);
    expect(outgoingLinkText({ ...IDLE_OUTGOING_LINK, phase: 'done', targetDeviceName: 'Pixel' })).toBe('Pixel is linked and has your history.');
    expect(
      outgoingLinkText({ ...IDLE_OUTGOING_LINK, phase: 'failed', error: { code: 'interrupted', message: 'The transfer was interrupted.' } }),
    ).toBe('The transfer was interrupted.');
  });
});

describe('password change form', () => {
  it('requires the current password, a valid new one, and the same one twice', () => {
    expect(hasPasswordErrors(validatePasswordChange('old-password', 'new-password', 'new-password'))).toBe(false);
    expect(validatePasswordChange('', 'short', 'other')).toEqual({
      current: 'Enter your current password.',
      next: 'Passwords have 8 to 128 characters.',
      repeat: 'The new passwords do not match.',
    });
  });
});
