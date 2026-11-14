import { uuidv4 } from '../../crypto/random';
import { PayloadError } from '../fields';
import { buildMessagePayload, isValidMessageBody, routeMessage } from '../message';
import { declaredKind, parsePayload } from '../parse';
import { buildReceiptPayload, routeReceipt } from '../receipt';
import { parseSnapshotBody } from '../snapshot';

const me = uuidv4();
const myDevice = uuidv4();
const otherDevice = uuidv4();
const bob = uuidv4();
const bobDevice = uuidv4();

function message(overrides: Record<string, unknown> = {}) {
  return { v: 1, kind: 'message', id: uuidv4(), from: bob, to: me, body: 'hi', sent_at: 1_731_492_000_000, ...overrides };
}

describe('message payload (§7.1)', () => {
  it('builds and parses the documented shape', () => {
    const built = buildMessagePayload({ id: uuidv4(), from: me, to: bob, body: 'hello', sentAt: 5 });
    expect(built).toEqual({ v: 1, kind: 'message', id: built.id, from: me, to: bob, body: 'hello', sent_at: 5 });
    expect(parsePayload(JSON.parse(JSON.stringify(built)))).toEqual({ kind: 'message', payload: built });
  });

  it.each([
    ['empty body', { body: '' }],
    ['body over 4000 characters', { body: 'a'.repeat(4001) }],
    ['body not a string', { body: 42 }],
    ['unpaired surrogate', { body: 'a\ud800b' }],
    ['uppercase uuid', { id: uuidv4().toUpperCase() }],
    ['not a uuid', { from: 'bob' }],
    ['self-chat', { from: me, to: me }],
    ['float timestamp', { sent_at: 1.5 }],
    ['negative timestamp', { sent_at: -1 }],
    ['string timestamp', { sent_at: '1731492000000' }],
  ])('rejects %s', (_name, overrides) => {
    expect(() => parsePayload(message(overrides))).toThrow(PayloadError);
  });

  it('counts characters as code points (4000 emoji are allowed)', () => {
    expect(isValidMessageBody('😀'.repeat(4000))).toBe(true);
    expect(isValidMessageBody('😀'.repeat(4001))).toBe(false);
  });

  it('acks-and-ignores unknown kinds and versions', () => {
    expect(parsePayload({ v: 2, kind: 'message' })).toEqual({ kind: 'unknown' });
    expect(parsePayload({ v: 1, kind: 'typing' })).toEqual({ kind: 'unknown' });
    expect(() => parsePayload('just a string')).toThrow(PayloadError);
    expect(declaredKind({ kind: 'message' })).toBe('message');
    expect(declaredKind(null)).toBeNull();
  });

  it('routes per the from/to rules', () => {
    const self = { userId: me, deviceId: myDevice };
    const incoming = parsePayload(message()) as { payload: ReturnType<typeof buildMessagePayload> };
    expect(routeMessage(incoming.payload, { senderUserId: bob, senderDeviceId: bobDevice }, self)).toEqual({
      kind: 'incoming',
      peer: bob,
    });
    // `from` must be the envelope's sender.
    expect(routeMessage(incoming.payload, { senderUserId: uuidv4(), senderDeviceId: bobDevice }, self).kind).toBe('drop');
    const sync = buildMessagePayload({ id: uuidv4(), from: me, to: bob, body: 'x', sentAt: 1 });
    expect(routeMessage(sync, { senderUserId: me, senderDeviceId: otherDevice }, self)).toEqual({ kind: 'sync', peer: bob });
    // A "sync copy" from this very device, or one claiming another sender, is dropped.
    expect(routeMessage(sync, { senderUserId: me, senderDeviceId: myDevice }, self).kind).toBe('drop');
    const forged = buildMessagePayload({ id: uuidv4(), from: bob, to: uuidv4(), body: 'x', sentAt: 1 });
    expect(routeMessage(forged, { senderUserId: me, senderDeviceId: otherDevice }, self).kind).toBe('drop');
    // Another user cannot send me something addressed to someone else.
    expect(routeMessage(forged, { senderUserId: bob, senderDeviceId: bobDevice }, self).kind).toBe('drop');
  });
});

describe('receipt payload (§7.2)', () => {
  const self = { userId: me, deviceId: myDevice };

  it('builds with deduplicated ids and validates limits', () => {
    const id = uuidv4();
    expect(buildReceiptPayload({ status: 'read', peer: bob, messageIds: [id, id], at: 1 }).message_ids).toEqual([id]);
    expect(() => buildReceiptPayload({ status: 'read', peer: bob, messageIds: [], at: 1 })).toThrow(PayloadError);
    const tooMany = Array.from({ length: 501 }, () => uuidv4());
    expect(() => parsePayload({ v: 1, kind: 'receipt', status: 'read', peer: bob, message_ids: tooMany, at: 1 })).toThrow(
      PayloadError,
    );
    expect(() => parsePayload({ v: 1, kind: 'receipt', status: 'seen', peer: bob, message_ids: [id], at: 1 })).toThrow(
      PayloadError,
    );
  });

  it('scopes receipts: peers update my outgoing rows, my devices sync reads', () => {
    const ids = [uuidv4()];
    const fromBob = buildReceiptPayload({ status: 'delivered', peer: me, messageIds: ids, at: 1 });
    expect(routeReceipt(fromBob, { senderUserId: bob, senderDeviceId: bobDevice }, self)).toEqual({
      kind: 'peer',
      peer: bob,
      status: 'delivered',
    });
    // Bob's receipt must be about his conversation with me.
    const misdirected = buildReceiptPayload({ status: 'read', peer: uuidv4(), messageIds: ids, at: 1 });
    expect(routeReceipt(misdirected, { senderUserId: bob, senderDeviceId: bobDevice }, self).kind).toBe('drop');
    const readSync = buildReceiptPayload({ status: 'read', peer: bob, messageIds: ids, at: 1 });
    expect(routeReceipt(readSync, { senderUserId: me, senderDeviceId: otherDevice }, self)).toEqual({ kind: 'readSync', peer: bob });
    const deliveredFromMe = buildReceiptPayload({ status: 'delivered', peer: bob, messageIds: ids, at: 1 });
    expect(routeReceipt(deliveredFromMe, { senderUserId: me, senderDeviceId: otherDevice }, self).kind).toBe('drop');
    expect(routeReceipt(readSync, { senderUserId: me, senderDeviceId: myDevice }, self).kind).toBe('drop');
  });
});

describe('snapshot records (§7.3, §10)', () => {
  const conv = { peer_user_id: bob, peer_username: 'bob', peer_avatar_url: 'https://cdn.example/a.jpg' };
  const out = { id: uuidv4(), peer_user_id: bob, direction: 'out', sender_user_id: me, body: 'x', sent_at: 1, server_ts: 2, status: 'read' };
  const inc = { ...out, id: uuidv4(), direction: 'in', sender_user_id: bob, status: 'received' };
  const ident = { user_id: bob, identity_key: Buffer.alloc(32, 7).toString('base64'), first_seen_at: 3, verified: true };

  it('keeps valid rows and counts invalid ones', () => {
    const parsed = parseSnapshotBody(
      {
        conversations: [conv, { ...conv, peer_user_id: me }, { ...conv, peer_avatar_url: 'javascript:alert(1)' }],
        messages: [
          out,
          inc,
          { ...out, status: 'received' },
          { ...inc, status: 'delivered' },
          { ...out, sender_user_id: bob },
          { ...inc, sender_user_id: me },
          { ...out, direction: 'system' },
          { ...out, body: '' },
        ],
        contact_identities: [ident, { ...ident, user_id: me }, { ...ident, identity_key: 'AAAA' }, { ...ident, verified: 'yes' }],
      },
      me,
    );
    expect(parsed.conversations).toHaveLength(1);
    expect(parsed.messages.map((m) => m.id)).toEqual([out.id, inc.id]);
    expect(parsed.contact_identities).toEqual([ident]);
    expect(parsed.skipped).toBe(2 + 6 + 3);
  });

  it('rejects a body without the three arrays', () => {
    expect(() => parseSnapshotBody({ conversations: [], messages: [] }, me)).toThrow(PayloadError);
    expect(() => parseSnapshotBody([], me)).toThrow(PayloadError);
  });
});
