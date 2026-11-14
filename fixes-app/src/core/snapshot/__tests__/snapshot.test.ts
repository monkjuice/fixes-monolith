import { openMemoryDatabase } from '../../../test-utils/nodeSqlite';
import { utf8Encode } from '../../crypto/encoding';
import { uuidv4 } from '../../crypto/random';
import { LocalStore } from '../../db/localStore';
import { parseReceiptPayload as parseOutboxReceipt } from '../../db/repositories/outbox';
import { queueReceipt } from '../../messaging/receiptQueue';
import type { MsgRecord, SnapshotBody } from '../../payloads/snapshot';
import { chunkSnapshot, readSnapshot } from '../export';

const me = uuidv4();
const bob = uuidv4();

function msg(body: string): MsgRecord {
  return { id: uuidv4(), peer_user_id: bob, direction: 'out', sender_user_id: me, body, sent_at: 1, server_ts: 1, status: 'sent' };
}

describe('history chunking (§7.3)', () => {
  it('keeps every chunk at or below 48 000 bytes of UTF-8 JSON and loses nothing', () => {
    const body: SnapshotBody = {
      conversations: [{ peer_user_id: bob, peer_username: 'bob', peer_avatar_url: null }],
      // Multi-byte text and JSON escapes count with their encoded size.
      messages: Array.from({ length: 60 }, (_, i) => msg(`${i} ${'é"\n😀'.repeat(900)}`)),
      contact_identities: [],
    };
    const chunks = chunkSnapshot(body);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(utf8Encode(JSON.stringify(chunk)).length).toBeLessThanOrEqual(48_000);
    expect(chunks.flatMap((c) => c.messages)).toEqual(body.messages);
    expect(chunks[0].conversations).toEqual(body.conversations);
  });

  it('always produces one chunk, even for an empty history (§9 step 6)', () => {
    expect(chunkSnapshot({ conversations: [], messages: [], contact_identities: [] })).toEqual([
      { conversations: [], messages: [], contact_identities: [] },
    ]);
  });

  it('exports everything but system messages, the outbox and receipt hints', async () => {
    const store = await LocalStore.open(openMemoryDatabase());
    await store.conversations.insertIfMissing({ peerUserId: bob, peerUsername: 'bob', peerAvatarUrl: null, lastActivityAt: 1 });
    const out = { ...msg('hi'), received_at: null, sort_ts: 1 };
    await store.messages.insertOrIgnore(out);
    await store.messages.insertSystem(bob, 'bob’s safety code changed', 2);
    await store.outbox.enqueueMessage(out.id, 1);
    await store.contactIdentities.pinIfAbsent(bob, Buffer.alloc(32, 1).toString('base64'), 3, true);
    const snapshot = await readSnapshot(store);
    expect(snapshot.messages.map((m) => m.id)).toEqual([out.id]);
    expect(snapshot.contact_identities).toEqual([
      { user_id: bob, identity_key: Buffer.alloc(32, 1).toString('base64'), first_seen_at: 3, verified: true },
    ]);
    expect(Object.keys(snapshot)).toEqual(['conversations', 'messages', 'contact_identities']);
    await store.close();
  });
});

describe('receipt coalescing (§7.2)', () => {
  it('merges ids per (peer, status) inside the debounce window, up to 500 per receipt', async () => {
    const store = await LocalStore.open(openMemoryDatabase());
    const carol = uuidv4();
    const ids = (n: number) => Array.from({ length: n }, () => uuidv4());
    await store.transaction(async (tx) => {
      await queueReceipt(tx, { peer: bob, status: 'delivered', ids: ids(3), now: 1000, debounceMs: 1000 });
      await queueReceipt(tx, { peer: bob, status: 'delivered', ids: ids(2), now: 1500, debounceMs: 1000 });
      await queueReceipt(tx, { peer: bob, status: 'read', ids: ids(1), now: 1500, debounceMs: 1000 });
      await queueReceipt(tx, { peer: carol, status: 'delivered', ids: ids(1), now: 1500, debounceMs: 1000 });
    });
    let rows = await store.outbox.listAll();
    expect(rows.map((r) => [parseOutboxReceipt(r)?.peer, parseOutboxReceipt(r)?.status, parseOutboxReceipt(r)?.message_ids.length])).toEqual([
      [bob, 'delivered', 5],
      [bob, 'read', 1],
      [carol, 'delivered', 1],
    ]);
    // After the window opened by the first row (due at 2000), a new receipt row starts.
    await store.transaction((tx) => queueReceipt(tx, { peer: bob, status: 'delivered', ids: ids(1), now: 2000, debounceMs: 1000 }));
    // Overflow beyond 500 ids spills into new rows.
    await store.transaction((tx) => queueReceipt(tx, { peer: bob, status: 'read', ids: ids(700), now: 1600, debounceMs: 1000 }));
    rows = await store.outbox.listAll();
    const reads = rows.map(parseOutboxReceipt).filter((p) => p?.peer === bob && p.status === 'read');
    expect(reads.map((p) => p!.message_ids.length)).toEqual([500, 201]);
    expect(rows.map(parseOutboxReceipt).filter((p) => p?.peer === bob && p.status === 'delivered')).toHaveLength(2);
    await store.close();
  });
});
