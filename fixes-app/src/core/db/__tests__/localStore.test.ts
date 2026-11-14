import { openMemoryDatabase } from '../../../test-utils/nodeSqlite';
import { uuidv4 } from '../../crypto/random';
import type { SqlDatabase } from '../../platform';
import { Topics } from '../changes';
import { LocalStore } from '../localStore';
import { getSchemaVersion, LATEST_SCHEMA_VERSION, migrate, MigrationError } from '../migrations';
import type { MessageRow } from '../types';

const me = uuidv4();
const bob = uuidv4();
const carol = uuidv4();

function message(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: uuidv4(),
    peer_user_id: bob,
    direction: 'in',
    sender_user_id: bob,
    body: 'hello',
    sent_at: 1000,
    server_ts: 1000,
    sort_ts: 1000,
    received_at: 1001,
    status: 'received',
    ...overrides,
  };
}

function outgoing(overrides: Partial<MessageRow> = {}): MessageRow {
  return message({ direction: 'out', sender_user_id: me, status: 'sent', ...overrides });
}

async function openStore(): Promise<{ store: LocalStore; db: SqlDatabase }> {
  const db = openMemoryDatabase();
  return { store: await LocalStore.open(db), db };
}

describe('migrations', () => {
  it('creates the §12.2 schema at user_version 1', async () => {
    const db = openMemoryDatabase();
    expect(await getSchemaVersion(db)).toBe(0);
    expect(await migrate(db)).toEqual({ from: 0, to: 1 });
    expect(LATEST_SCHEMA_VERSION).toBe(1);
    expect(await getSchemaVersion(db)).toBe(1);
    const tables = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    expect(tables.map((t) => t.name)).toEqual([
      'contact_identities',
      'conversations',
      'history_transfers',
      'messages',
      'messages_by_conversation',
      'outbox',
      'receipt_hints',
    ]);
  });

  it('is idempotent', async () => {
    const db = openMemoryDatabase();
    await migrate(db);
    expect(await migrate(db)).toEqual({ from: 1, to: 1 });
  });

  it('refuses a database from a newer app version', async () => {
    const db = openMemoryDatabase();
    await db.execAsync('PRAGMA user_version = 99');
    await expect(LocalStore.open(db)).rejects.toBeInstanceOf(MigrationError);
  });

  it('enforces the direction and outbox kind CHECK constraints', async () => {
    const { store } = await openStore();
    await expect(
      store.sql.runAsync(
        "INSERT INTO messages (id, peer_user_id, direction, body, sent_at, sort_ts, status) VALUES ('x', 'p', 'sideways', 'b', 0, 0, 'none')",
      ),
    ).rejects.toThrow(/CHECK/);
    // The repository refuses inconsistent rows instead of reporting them as duplicates.
    await expect(store.messages.insertOrIgnore(message({ direction: 'sideways' as never }))).rejects.toThrow(RangeError);
    await expect(store.messages.insertOrIgnore(message({ direction: 'in', status: 'sent' }))).rejects.toThrow(RangeError);
    await expect(store.sql.runAsync("INSERT INTO outbox (kind, next_attempt_at, created_at) VALUES ('x', 0, 0)")).rejects.toThrow(
      /CHECK/,
    );
  });
});

describe('messages repository', () => {
  it('insert-or-ignore reports whether a row was inserted', async () => {
    const { store } = await openStore();
    const row = message();
    expect(await store.messages.insertOrIgnore(row)).toBe(true);
    expect(await store.messages.insertOrIgnore({ ...row, body: 'changed' })).toBe(false);
    expect((await store.messages.get(row.id))?.body).toBe('hello');
  });

  it('moves outgoing statuses forward only', async () => {
    const { store } = await openStore();
    const row = outgoing({ status: 'pending' });
    await store.messages.insertOrIgnore(row);
    const up = (status: 'sent' | 'delivered' | 'read' | 'failed' | 'pending') =>
      store.messages.updateStatusForward({ peerUserId: bob, direction: 'out', status, ids: [row.id] });
    expect(await up('delivered')).toEqual([row.id]);
    expect(await up('sent')).toEqual([]); // backwards
    expect(await up('delivered')).toEqual([]); // same
    expect(await up('read')).toEqual([row.id]);
    expect(await up('failed')).toEqual([]);
    expect((await store.messages.get(row.id))?.status).toBe('read');
  });

  it('moves incoming statuses forward only', async () => {
    const { store } = await openStore();
    const row = message();
    await store.messages.insertOrIgnore(row);
    expect(await store.messages.updateStatusForward({ peerUserId: bob, direction: 'in', status: 'read', ids: [row.id] })).toEqual([
      row.id,
    ]);
    expect(
      await store.messages.updateStatusForward({ peerUserId: bob, direction: 'in', status: 'received', ids: [row.id] }),
    ).toEqual([]);
  });

  it('scopes status updates by peer and direction (§7.2)', async () => {
    const { store } = await openStore();
    const toBob = outgoing();
    const toCarol = outgoing({ peer_user_id: carol });
    const fromBob = message();
    for (const r of [toBob, toCarol, fromBob]) await store.messages.insertOrIgnore(r);
    // A receipt from Bob naming Carol's and his own incoming message ids must not touch them.
    const changed = await store.messages.updateStatusForward({
      peerUserId: bob,
      direction: 'out',
      status: 'read',
      ids: [toBob.id, toCarol.id, fromBob.id, uuidv4()],
    });
    expect(changed).toEqual([toBob.id]);
    expect((await store.messages.get(toCarol.id))?.status).toBe('sent');
    expect((await store.messages.get(fromBob.id))?.status).toBe('received');
  });

  it('handles id lists larger than one SQL chunk', async () => {
    const { store } = await openStore();
    const ids: string[] = [];
    await store.transaction(async (tx) => {
      for (let i = 0; i < 450; i++) {
        const r = outgoing({ sort_ts: i });
        ids.push(r.id);
        await tx.messages.insertOrIgnore(r);
      }
    });
    const changed = await store.messages.updateStatusForward({ peerUserId: bob, direction: 'out', status: 'delivered', ids });
    expect(changed).toHaveLength(450);
  });

  it('marks viewed incoming messages read and returns exactly the changed ids', async () => {
    const { store } = await openStore();
    const a = message({ sort_ts: 1 });
    const b = message({ sort_ts: 2 });
    const already = message({ sort_ts: 3, status: 'read' });
    const mine = outgoing({ sort_ts: 4 });
    for (const r of [a, b, already, mine]) await store.messages.insertOrIgnore(r);
    expect((await store.messages.markIncomingRead(bob)).sort()).toEqual([a.id, b.id].sort());
    expect(await store.messages.markIncomingRead(bob)).toEqual([]);
    expect(await store.messages.countUnread(bob)).toBe(0);
  });

  it('markSent sets the server timestamp and moves pending/failed forward but never back', async () => {
    const { store } = await openStore();
    const pending = outgoing({ status: 'pending', server_ts: null, sort_ts: 5 });
    const read = outgoing({ status: 'read', server_ts: null, sort_ts: 6 });
    await store.messages.insertOrIgnore(pending);
    await store.messages.insertOrIgnore(read);
    expect(await store.messages.markSent(pending.id, 900)).toBe(true);
    expect(await store.messages.get(pending.id)).toMatchObject({ status: 'sent', server_ts: 900, sort_ts: 900 });
    await store.messages.markSent(read.id, 901);
    expect((await store.messages.get(read.id))?.status).toBe('read');
  });

  it('pending → failed → pending (retry) only through the dedicated transitions', async () => {
    const { store } = await openStore();
    const row = outgoing({ status: 'pending' });
    await store.messages.insertOrIgnore(row);
    expect(await store.messages.markFailed(row.id)).toBe(true);
    expect(await store.messages.markFailed(row.id)).toBe(false);
    expect(await store.messages.retryFailed(row.id)).toBe(true);
    await store.messages.markSent(row.id, 50);
    expect(await store.messages.markFailed(row.id)).toBe(false);
    expect((await store.messages.get(row.id))?.status).toBe('sent');
  });

  it('paginates newest first by sort_ts with id tie-breaks', async () => {
    const { store } = await openStore();
    const rows: MessageRow[] = [];
    for (let i = 0; i < 7; i++) {
      // Two rows share each sort_ts to exercise the tie-break.
      const r = message({ id: `0000000${i}-0000-4000-8000-000000000000`, sort_ts: Math.floor(i / 2) });
      rows.push(r);
      await store.messages.insertOrIgnore(r);
    }
    await store.messages.insertOrIgnore(message({ peer_user_id: carol, sort_ts: 100 }));
    const seen: string[] = [];
    let page = await store.messages.listPage(bob, { limit: 3 });
    while (page.length > 0) {
      seen.push(...page.map((r) => r.id));
      const last = page[page.length - 1];
      page = await store.messages.listPage(bob, { limit: 3, before: { sortTs: last.sort_ts, id: last.id } });
    }
    const expected = [...rows].sort((x, y) => y.sort_ts - x.sort_ts || (x.id < y.id ? 1 : -1)).map((r) => r.id);
    expect(seen).toEqual(expected);
  });

  it('inserts system messages', async () => {
    const { store } = await openStore();
    const row = await store.messages.insertSystem(bob, "bob's safety code changed", 1234);
    expect(await store.messages.get(row.id)).toMatchObject({ direction: 'system', status: 'none', sender_user_id: null });
    expect(await store.messages.latestNonSystem(bob)).toBeNull();
  });

  it('finds the most recently inserted system message with a suffix, then follows what was inserted after it', async () => {
    const { store } = await openStore();
    const suffix = ' could not be decrypted';
    expect(await store.messages.lastInsertedSystem(bob, suffix)).toBeNull();
    await store.messages.insertSystem(bob, `A message from bob${suffix}`, 5000);
    // Insertion order, not sort_ts, decides.
    const newest = await store.messages.insertSystem(bob, `2 messages from bob${suffix}`, 1000);
    await store.messages.insertSystem(bob, "bob's safety code changed", 9000);
    const carols = await store.messages.insertSystem(carol, `A message from carol${suffix}`, 9000);

    const last = await store.messages.lastInsertedSystem(bob, suffix);
    expect(last).toEqual({ row: await store.messages.get(newest.id), rowid: await store.messages.rowidOf(newest.id) });
    const rowid = last!.rowid;
    const top = (await store.messages.rowidOf(carols.id))!;
    expect(await store.messages.insertedSince(bob, rowid, suffix)).toEqual({ incoming: false, system: false, top });

    // Neither carol's incoming message nor an outgoing one to bob is an incoming message from bob.
    await store.messages.insertOrIgnore(message({ peer_user_id: carol, sender_user_id: carol }));
    await store.messages.insertOrIgnore(outgoing());
    const quiet = await store.messages.insertedSince(bob, top, suffix);
    expect(quiet).toEqual({ incoming: false, system: false, top: top + 2 });

    await store.messages.insertOrIgnore(message());
    expect(await store.messages.insertedSince(bob, rowid, suffix)).toMatchObject({ incoming: true, system: false });
    // Only rows after the given rowid count.
    const afterIncoming = await store.messages.insertedSince(bob, rowid, suffix);
    expect(await store.messages.insertedSince(bob, afterIncoming.top, suffix)).toMatchObject({ incoming: false });

    await store.messages.insertSystem(bob, `A message from bob${suffix}`, 1);
    expect(await store.messages.insertedSince(bob, afterIncoming.top, suffix)).toMatchObject({ incoming: false, system: true });
    expect(await store.messages.rowidOf('no such id')).toBeNull();
  });

  it('follows inserted rows by rowid range, never by visiting the whole conversation', async () => {
    const { store, db } = await openStore();
    const statements: { sql: string; params?: readonly (string | number | null | Uint8Array)[] }[] = [];
    const getFirst = db.getFirstAsync.bind(db);
    db.getFirstAsync = <T>(sql: string, params?: readonly (string | number | null | Uint8Array)[]) => {
      statements.push({ sql, params });
      return getFirst<T>(sql, params);
    };
    await store.messages.insertedSince(bob, 0, ' could not be decrypted');
    expect(statements).toHaveLength(1);
    const plan = await store.sql.getAllAsync<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${statements[0].sql}`,
      statements[0].params,
    );
    const details = plan.map((p) => p.detail);
    expect(details.filter((d) => d.includes('USING INTEGER PRIMARY KEY (rowid>?)'))).toHaveLength(2);
    // No index walk over the conversation, no full scan (max(rowid) is a single seek: "SEARCH messages").
    expect(details.join('\n')).not.toMatch(/messages_by_conversation|SCAN messages/);
  });
});

describe('conversations repository', () => {
  it('inserts only when missing and keeps last activity monotonic', async () => {
    const { store } = await openStore();
    expect(await store.conversations.insertIfMissing({ peerUserId: bob, peerUsername: 'bob', peerAvatarUrl: null, lastActivityAt: 10 })).toBe(
      true,
    );
    expect(await store.conversations.insertIfMissing({ peerUserId: bob, peerUsername: 'other', peerAvatarUrl: null, lastActivityAt: 99 })).toBe(
      false,
    );
    await store.conversations.bumpActivity(bob, 50);
    await store.conversations.bumpActivity(bob, 20);
    expect(await store.conversations.get(bob)).toMatchObject({ peer_username: 'bob', last_activity_at: 50 });
  });

  it('lists the inbox by activity with the newest non-system message', async () => {
    const { store } = await openStore();
    await store.conversations.insertIfMissing({ peerUserId: bob, peerUsername: 'bob', peerAvatarUrl: null, lastActivityAt: 5 });
    await store.conversations.insertIfMissing({ peerUserId: carol, peerUsername: 'carol', peerAvatarUrl: 'https://x/a.jpg', lastActivityAt: 9 });
    const last = outgoing({ sort_ts: 5, body: 'latest', status: 'delivered' });
    await store.messages.insertOrIgnore(message({ sort_ts: 4 }));
    await store.messages.insertOrIgnore(last);
    await store.messages.insertSystem(bob, 'system note', 6);
    const inbox = await store.conversations.listInbox();
    expect(inbox.map((c) => c.peer_user_id)).toEqual([carol, bob]);
    expect(inbox[0].last_message_id).toBeNull();
    expect(inbox[1]).toMatchObject({ last_message_id: last.id, last_direction: 'out', last_body: 'latest', last_status: 'delivered' });
  });

  it('counts unread and refreshes profiles', async () => {
    const { store } = await openStore();
    await store.conversations.insertIfMissing({ peerUserId: bob, peerUsername: 'user', peerAvatarUrl: null, lastActivityAt: 1 });
    await store.messages.insertOrIgnore(message());
    await store.messages.insertOrIgnore(message());
    await store.conversations.incrementUnread(bob);
    await store.conversations.recountUnread(bob);
    expect((await store.conversations.get(bob))?.unread_count).toBe(2);
    expect(await store.conversations.listPeersToRefresh(100)).toEqual([bob]);
    await store.conversations.updateProfile(bob, 'bob', 'https://x/b.jpg', 200);
    expect(await store.conversations.listPeersToRefresh(100)).toEqual([]);
    expect((await store.conversations.get(bob))?.peer_username).toBe('bob');
  });
});

describe('outbox, receipt hints, contacts, transfers', () => {
  it('queues and schedules outbox work', async () => {
    const { store } = await openStore();
    const m = await store.outbox.enqueueMessage(uuidv4(), 100);
    const r = await store.outbox.enqueueReceipt({ peer: bob, status: 'read', message_ids: ['a'] }, 100);
    expect(r).toBeGreaterThan(m);
    await store.outbox.reschedule(m, 500);
    expect((await store.outbox.listDue(200)).map((o) => o.id)).toEqual([r]);
    expect(await store.outbox.nextAttemptAt()).toBe(100);
    expect((await store.outbox.listAll())[0]).toMatchObject({ attempts: 1, next_attempt_at: 500 });
    await store.outbox.delete(r);
    expect(await store.outbox.count()).toBe(1);
  });

  it('keeps the most advanced receipt hint and hands hints out once', async () => {
    const { store } = await openStore();
    await store.receiptHints.put('m1', 'read', 10);
    await store.receiptHints.put('m1', 'delivered', 20);
    await store.receiptHints.put('m2', 'delivered', 30);
    await store.receiptHints.put('m2', 'read', 40);
    expect(await store.receiptHints.listAll()).toEqual([
      { message_id: 'm1', status: 'read', at: 10 },
      { message_id: 'm2', status: 'read', at: 40 },
    ]);
    expect((await store.receiptHints.take(['m1', 'zz'])).map((h) => h.message_id)).toEqual(['m1']);
    expect(await store.receiptHints.take(['m1'])).toEqual([]);
    expect(await store.receiptHints.pruneOlderThan(41)).toBe(1);
  });

  it('pins contact identities on first use and handles key changes', async () => {
    const { store } = await openStore();
    expect(await store.contactIdentities.pinIfAbsent(bob, 'KEY1', 1)).toBe(true);
    expect(await store.contactIdentities.pinIfAbsent(bob, 'KEY2', 2)).toBe(false);
    await store.contactIdentities.setVerified(bob, true);
    expect(await store.contactIdentities.setPending(bob, 'KEY1')).toBe(false); // same as pinned
    expect(await store.contactIdentities.setPending(bob, 'KEY2')).toBe(true);
    expect(await store.contactIdentities.acceptPending(bob)).toBe(true);
    expect(await store.contactIdentities.get(bob)).toEqual({
      user_id: bob,
      identity_key: 'KEY2',
      first_seen_at: 1,
      verified: 0,
      pending_identity_key: null,
    });
  });

  it('tracks history transfer attempts and completion', async () => {
    const { store } = await openStore();
    const id = uuidv4();
    await store.historyTransfers.create(id, 'S0VZ', 1);
    await store.historyTransfers.bindAttempt(id, uuidv4(), uuidv4(), 3, 2);
    await store.historyTransfers.recordSeq(id, 2, 3);
    await store.historyTransfers.recordSeq(id, 0, 4);
    const row = await store.historyTransfers.recordSeq(id, 2, 5);
    expect(row?.received_seqs).toEqual([0, 2]);
    // A new attempt restarts the sequence numbers.
    await store.historyTransfers.bindAttempt(id, uuidv4(), uuidv4(), 2, 6);
    expect((await store.historyTransfers.get(id))?.received_seqs).toEqual([]);
    await store.historyTransfers.complete(id, 7);
    expect(await store.historyTransfers.get(id)).toMatchObject({ transfer_key: null, completed_at: 7 });
    expect(await store.historyTransfers.listOpen()).toEqual([]);
  });
});

describe('transactions and change notifications', () => {
  it('notifies topics after commit only', async () => {
    const { store } = await openStore();
    const seen: string[] = [];
    store.changes.subscribe(Topics.conversations, (t) => seen.push(t));
    store.changes.subscribe(Topics.messages(bob), (t) => seen.push(t));
    await store.transaction(async (tx) => {
      await tx.messages.insertOrIgnore(message());
      await tx.conversations.insertIfMissing({ peerUserId: bob, peerUsername: 'bob', peerAvatarUrl: null, lastActivityAt: 1 });
      expect(seen).toEqual([]);
    });
    expect(seen.sort()).toEqual([Topics.conversations, Topics.messages(bob)].sort());
  });

  it('rolls back and discards notifications on error', async () => {
    const { store } = await openStore();
    const seen: string[] = [];
    store.changes.subscribe(Topics.messages(bob), (t) => seen.push(t));
    const row = message();
    await expect(
      store.transaction(async (tx) => {
        await tx.messages.insertOrIgnore(row);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await store.messages.get(row.id)).toBeNull();
    expect(seen).toEqual([]);
  });

  it('serialises statements so concurrent writes never join an open transaction', async () => {
    const { store } = await openStore();
    const inTx = message();
    const outside = message();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tx = store.transaction(async (t) => {
      await t.messages.insertOrIgnore(inTx);
      await gate;
      throw new Error('rollback');
    });
    // Issued while the transaction is open; must run after it and survive its rollback.
    const write = store.messages.insertOrIgnore(outside);
    release();
    await expect(tx).rejects.toThrow('rollback');
    await expect(write).resolves.toBe(true);
    expect(await store.messages.get(inTx.id)).toBeNull();
    expect(await store.messages.get(outside.id)).not.toBeNull();
  });

  it('a listener that throws does not break the write', async () => {
    const { store } = await openStore();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    store.changes.subscribe(Topics.messages(bob), () => {
      throw new Error('listener bug');
    });
    await expect(store.messages.insertOrIgnore(message())).resolves.toBe(true);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('rejects use after close and use of a finished transaction', async () => {
    const { store } = await openStore();
    let leaked: Parameters<Parameters<LocalStore['transaction']>[0]>[0] | null = null;
    await store.transaction(async (tx) => {
      leaked = tx;
    });
    await expect(leaked!.messages.get('x')).rejects.toThrow(/already finished/);
    await store.close();
    await expect(store.messages.get('x')).rejects.toThrow(/closed/);
  });
});
