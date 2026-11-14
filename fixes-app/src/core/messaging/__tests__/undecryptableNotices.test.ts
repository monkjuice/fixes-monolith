import { CapturingLogger } from '../../../test-utils';
import { openMemoryDatabase } from '../../../test-utils/nodeSqlite';
import type { Envelope } from '../../api/types';
import { CryptoError } from '../../crypto/errors';
import { uuidv4 } from '../../crypto/random';
import { Topics } from '../../db/changes';
import { LocalStore } from '../../db/localStore';
import { MessagesRepository } from '../../db/repositories/messages';
import type { MessageRow } from '../../db/types';
import { buildMessagePayload } from '../../payloads/message';
import type { DeviceDirectory } from '../../trust/deviceDirectory';
import { undecryptableCount, undecryptableText } from '../conversationSummary';
import type { EnvelopeCodec } from '../envelopeCodec';
import { EnvelopeProcessor } from '../envelopeProcessor';

/**
 * Protocol §13: undecryptable messages from a known contact collapse into one notice per run of
 * consecutive failures, which counts them. These tests drive the EnvelopeProcessor directly (real
 * SQLite store; key lookup and decryption stubbed) so pages, redelivery and restarts are exact.
 */

const me = uuidv4();
const myDevice = uuidv4();
const BOB = { user: uuidv4(), device: uuidv4(), name: 'bob' };
const CAROL = { user: uuidv4(), device: uuidv4(), name: 'carol' };
type Contact = typeof BOB;

/** Opens only the envelopes a test gave a payload; anything else fails like a bad ciphertext. */
class FakeCodec {
  readonly plaintexts = new Map<string, unknown>();

  open(envelope: Envelope): unknown {
    if (!this.plaintexts.has(envelope.id)) throw new CryptoError('decrypt_failed', 'Envelope authentication failed');
    return this.plaintexts.get(envelope.id);
  }
}

const allowAnySender = {
  resolveSender: async () => ({ publicKey: new Uint8Array(32), viaPending: false, viaAccountOnly: false }),
} as unknown as DeviceDirectory;

async function harness() {
  const store = await LocalStore.open(openMemoryDatabase());
  const codec = new FakeCodec();
  const logger = new CapturingLogger();
  // Server time of the next envelope; the phone's clock runs a little behind the server.
  let serverTime = Date.UTC(2026, 10, 13, 10, 0, 0);
  let envelopeCounter = 0;
  const clock = { now: () => serverTime + 250 };
  for (const contact of [BOB, CAROL]) {
    await store.conversations.insertIfMissing({
      peerUserId: contact.user,
      peerUsername: contact.name,
      peerAvatarUrl: null,
      lastActivityAt: serverTime - 60_000,
    });
  }

  const newProcessor = () =>
    new EnvelopeProcessor({
      store,
      directory: allowAnySender,
      codec: codec as unknown as EnvelopeCodec,
      self: { userId: me, deviceId: myDevice },
      transfers: { prepare: async () => null, apply: async () => null, afterCommit: () => undefined },
      clock,
      logger,
      receiptDebounceMs: 1_000,
    });

  const h = {
    store,
    logger,
    /** The running processor; `restart()` replaces it, as a new app start (or runtime) would. */
    processor: newProcessor(),
    newProcessor,
    restart() {
      h.processor = newProcessor();
    },
    /** Server time passes (the phone's clock follows it). */
    later(ms = 1_000) {
      serverTime += ms;
    },
    /** An envelope as the server lists it; envelopes of one POST share `createdAt`. */
    envelope(from: Contact, createdAt?: number): Envelope {
      if (createdAt === undefined) serverTime += 1_000;
      envelopeCounter += 1;
      return {
        id: envelopeCounter.toString(16).padStart(24, '0'),
        sender_user_id: from.user,
        sender_device_id: from.device,
        recipient_device_id: myDevice,
        nonce: 'AAAA',
        ciphertext: 'AAAA',
        created_at: new Date(createdAt ?? serverTime).toISOString(),
      };
    },
    junk(from: Contact = BOB, createdAt?: number): Envelope {
      return h.envelope(from, createdAt);
    },
    message(from: Contact, body: string): Envelope {
      const envelope = h.envelope(from);
      codec.plaintexts.set(
        envelope.id,
        buildMessagePayload({ id: uuidv4(), from: from.user, to: me, body, sentAt: serverTime }),
      );
      return envelope;
    },
    async process(envelopes: Envelope[]) {
      const result = await h.processor.process(envelopes);
      expect(result.stoppedBy).toBeNull();
      expect(result.handledIds).toEqual(envelopes.map((e) => e.id));
    },
    /** Oldest first. */
    async rows(contact: Contact): Promise<MessageRow[]> {
      return (await store.messages.listPage(contact.user, { limit: 500 })).reverse();
    },
    async notices(contact: Contact): Promise<MessageRow[]> {
      return (await h.rows(contact)).filter((m) => m.direction === 'system');
    },
    async bodies(contact: Contact): Promise<string[]> {
      return (await h.rows(contact)).map((m) => (m.direction === 'system' ? `[${m.body}]` : m.body));
    },
    /** `count` old messages with `contact` (alternating in/out), stored as an import would. */
    async addHistory(contact: Contact, count: number) {
      await store.transaction((tx) =>
        tx.sql.runAsync(
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
           INSERT INTO messages
             (id, peer_user_id, direction, sender_user_id, body, sent_at, server_ts, sort_ts, received_at, status)
           SELECT ? || '-' || i, ?, CASE i % 2 WHEN 1 THEN 'in' ELSE 'out' END,
                  CASE i % 2 WHEN 1 THEN ? ELSE ? END, 'old message ' || i, i, i, i, i, 'read'
           FROM n`,
          [count, contact.user, contact.user, contact.user, me],
        ),
      );
    },
  };
  return h;
}

describe('undecryptable-message notices (§13)', () => {
  it('collapses consecutive failures into one notice that counts them and keeps its position', async () => {
    const h = await harness();
    await h.process([h.message(BOB, 'before')]);
    await h.process([h.junk()]);
    const [first] = await h.notices(BOB);
    expect(first.body).toBe('A message from bob could not be decrypted');

    h.later(60_000);
    await h.process([h.junk(), h.junk()]);
    h.later(60_000);
    await h.process([h.junk()]);
    await h.process([h.junk(), h.junk(), h.junk()]);

    // Same row, same place in the conversation (sort_ts of the first failure); only the text changed.
    expect(await h.notices(BOB)).toEqual([
      { ...first, body: '7 messages from bob could not be decrypted', server_ts: expect.any(Number) },
    ]);
    await h.process([h.message(BOB, 'after')]);
    expect(await h.bodies(BOB)).toEqual(['before', '[7 messages from bob could not be decrypted]', 'after']);
    expect(h.logger.errors()).toEqual([]);
  });

  it('never changes unread_count or last_activity_at, and only notifies the conversation topic', async () => {
    const h = await harness();
    await h.process([h.message(BOB, 'unread one')]);
    const before = await h.store.conversations.get(BOB.user);
    expect(before).toMatchObject({ unread_count: 1 });

    const topics: string[] = [];
    h.store.changes.subscribe(Topics.conversations, (t) => topics.push(t));
    h.store.changes.subscribe(Topics.messages(BOB.user), (t) => topics.push(t));
    await h.process([h.junk()]);
    await h.process([h.junk(), h.junk()]);

    expect(await h.store.conversations.get(BOB.user)).toEqual(before);
    // The inbox (conversations topic) is untouched; the open conversation re-reads the changed notice.
    expect(topics).toEqual([Topics.messages(BOB.user), Topics.messages(BOB.user)]);
  });

  it('ends the run when a message from the contact is stored; the next failure starts a new notice', async () => {
    const h = await harness();
    await h.process([h.junk(), h.junk()]);
    await h.process([h.message(BOB, 'readable')]);
    await h.process([h.junk()]);
    // Within one page too: the message between the failures splits them.
    await h.process([h.junk(), h.message(BOB, 'also readable'), h.junk()]);

    expect(await h.bodies(BOB)).toEqual([
      '[2 messages from bob could not be decrypted]',
      'readable',
      '[2 messages from bob could not be decrypted]',
      'also readable',
      '[A message from bob could not be decrypted]',
    ]);
  });

  it('does not end the run for a message that was already stored (a duplicate)', async () => {
    const h = await harness();
    const readable = h.message(BOB, 'readable');
    await h.process([readable]);
    await h.process([h.junk()]);
    // The same message again (redelivered): nothing is stored, so the failures stay consecutive.
    await h.process([readable, h.junk()]);

    expect(await h.bodies(BOB)).toEqual(['readable', '[2 messages from bob could not be decrypted]']);
  });

  it('counts failures from different contacts separately', async () => {
    const h = await harness();
    await h.process([h.junk(BOB), h.junk(CAROL), h.junk(BOB)]);
    await h.process([h.junk(CAROL), h.junk(BOB)]);
    // A message from carol ends carol's run only.
    await h.process([h.message(CAROL, 'hi from carol')]);
    await h.process([h.junk(BOB), h.junk(CAROL)]);

    expect(await h.bodies(BOB)).toEqual(['[4 messages from bob could not be decrypted]']);
    expect(await h.bodies(CAROL)).toEqual([
      '[2 messages from carol could not be decrypted]',
      'hi from carol',
      '[A message from carol could not be decrypted]',
    ]);
  });

  it('counts every envelope of one POST (they share created_at), also across pages', async () => {
    const h = await harness();
    h.later();
    const batch = Date.UTC(2026, 10, 13, 10, 30, 0);
    await h.process([h.junk(BOB, batch), h.junk(BOB, batch), h.junk(BOB, batch)]);
    await h.process([h.junk(BOB, batch), h.junk(BOB, batch)]);

    expect(await h.bodies(BOB)).toEqual(['[5 messages from bob could not be decrypted]']);
  });

  it('counts an envelope once when it is processed again in the same session', async () => {
    const h = await harness();
    const page = [h.junk(), h.junk()];
    await h.process(page);
    await h.process(page);
    await h.process([page[1], h.junk(), page[0]]);

    expect(await h.bodies(BOB)).toEqual(['[3 messages from bob could not be decrypted]']);
  });

  it('counts an envelope once when its page is redelivered after a restart', async () => {
    const h = await harness();
    const page = [h.junk(), h.junk()];
    await h.process(page);
    // Applied but never acked: after the restart the server lists the same envelopes first.
    h.restart();
    await h.process(page);
    expect(await h.bodies(BOB)).toEqual(['[2 messages from bob could not be decrypted]']);
    // The run survives the restart: a new failure still collapses into the same notice.
    h.restart();
    await h.process([...page, h.junk()]);
    expect(await h.bodies(BOB)).toEqual(['[3 messages from bob could not be decrypted]']);

    // A redelivered page whose failures were split by a stored message changes nothing either.
    const split = [h.junk(), h.message(BOB, 'readable'), h.junk()];
    await h.process(split);
    h.restart();
    await h.process(split);
    expect(await h.bodies(BOB)).toEqual([
      '[4 messages from bob could not be decrypted]',
      'readable',
      '[A message from bob could not be decrypted]',
    ]);
  });

  it('continues a notice written before counting existed', async () => {
    const h = await harness();
    // Older versions inserted one plain notice per envelope (no server_ts).
    await h.store.messages.insertSystem(BOB.user, 'A message from bob could not be decrypted', Date.now());
    await h.process([h.junk()]);

    expect(await h.bodies(BOB)).toEqual(['[2 messages from bob could not be decrypted]']);
  });

  it('names the contact as currently known when the notice is updated', async () => {
    const h = await harness();
    await h.process([h.junk()]);
    await h.store.conversations.updateProfile(BOB.user, 'robert', null, Date.now());
    await h.process([h.junk()]);

    expect(await h.bodies(BOB)).toEqual(['[2 messages from robert could not be decrypted]']);
  });

  it('adds no notice for a sender without a conversation', async () => {
    const h = await harness();
    const stranger = { user: uuidv4(), device: uuidv4(), name: 'stranger' };
    await h.process([h.junk(stranger), h.junk(stranger)]);

    expect(await h.rows(stranger)).toEqual([]);
    expect(await h.store.conversations.get(stranger.user)).toBeNull();
  });
});

describe('following the open notice', () => {
  // A flood of 500 failures, timed. With a long history, the contact's open notice lies behind 30 000 of
  // their messages and is followed by 30 000 of carol's; the app restarts first, so the notice has to be
  // found again. Each failure used to look the notice up through the whole conversation (seconds here).
  async function timeFlood(history: number): Promise<number> {
    const h = await harness();
    if (history > 0) {
      await h.addHistory(BOB, history);
      await h.process([h.junk()]);
      await h.addHistory(CAROL, history);
      h.restart();
    }
    const started = Date.now();
    for (let page = 0; page < 5; page++) await h.process(Array.from({ length: 100 }, () => h.junk()));
    const elapsed = Date.now() - started;
    const count = history > 0 ? 501 : 500;
    expect((await h.notices(BOB)).map((m) => m.body)).toEqual([`${count} messages from bob could not be decrypted`]);
    return elapsed;
  }

  it('costs a flood the same in a long conversation as in an empty one', async () => {
    const empty = await timeFlood(0);
    const long = await timeFlood(30_000);
    expect(long).toBeLessThan(empty * 3 + 300);
  }, 120_000);

  it('ends the run for a message from the contact stored by another writer (an import)', async () => {
    const h = await harness();
    await h.process([h.junk(), h.junk()]);
    const imported: MessageRow = {
      id: uuidv4(),
      peer_user_id: BOB.user,
      direction: 'in',
      sender_user_id: BOB.user,
      body: 'imported',
      sent_at: 1,
      server_ts: 1,
      sort_ts: 1,
      received_at: 1,
      status: 'read',
    };
    await h.store.messages.insertOrIgnore(imported);
    await h.process([h.junk()]);

    expect((await h.notices(BOB)).map((m) => m.body)).toEqual([
      '2 messages from bob could not be decrypted',
      'A message from bob could not be decrypted',
    ]);
  });

  it('continues a newer notice another processor wrote to the same database', async () => {
    const h = await harness();
    const first = h.processor;
    const second = h.newProcessor();
    await first.process([h.junk()]);
    // The other processor stores a message (ending the run) and starts a new notice.
    await second.process([h.message(BOB, 'readable'), h.junk()]);
    // The first one must count into that new notice, not start a third.
    await first.process([h.junk()]);

    expect(await h.bodies(BOB)).toEqual([
      '[A message from bob could not be decrypted]',
      'readable',
      '[2 messages from bob could not be decrypted]',
    ]);
  });

  it('keeps nothing from a page that rolled back (its rowids are handed out again)', async () => {
    const h = await harness();
    await h.process([h.junk()]);
    const insert = MessagesRepository.prototype.insertOrIgnore;
    const failing = jest
      .spyOn(MessagesRepository.prototype, 'insertOrIgnore')
      .mockImplementation(async function (this: MessagesRepository, row: MessageRow) {
        if (row.body === 'boom') throw new Error('disk I/O error');
        return insert.call(this, row);
      });
    // Carol's message and bob's failure are applied, then the page fails and rolls back.
    await expect(
      h.processor.process([h.message(CAROL, 'from carol'), h.junk(), h.message(BOB, 'boom')]),
    ).rejects.toThrow('disk I/O error');
    failing.mockRestore();
    // Bob's message gets the rowid carol's rolled-back message had; it still ends the run.
    await h.process([h.message(BOB, 'readable'), h.junk()]);

    expect(await h.bodies(BOB)).toEqual([
      '[A message from bob could not be decrypted]',
      'readable',
      '[A message from bob could not be decrypted]',
    ]);
    expect(await h.bodies(CAROL)).toEqual([]);
  });
});

/**
 * Known limits (README): after a restart, an envelope no newer than the open notice's `server_ts` is
 * taken as the redelivery of a page that was applied but not acked. The mailbox lists envelopes in id
 * order (§5.3), not in `created_at` order, and §12.2 has no column for the id, so that test can be wrong.
 * These pin how, so a change in behaviour is deliberate.
 */
describe('redelivery after a restart: known limits', () => {
  it('undercounts the rest of a multi-envelope POST when a page ended inside it', async () => {
    const h = await harness();
    h.later();
    const T = Date.UTC(2026, 10, 13, 11, 0, 0);
    // A hostile contact's POST of 100 envelopes for this device: one created_at for all of them. At the
    // 4 MiB page cap, 64 KiB ciphertexts make pages of 64.
    const post = Array.from({ length: 100 }, () => h.junk(BOB, T));
    await h.process(post.slice(0, 64));
    h.restart();
    await h.process(post.slice(64));
    expect(await h.bodies(BOB)).toEqual(['[64 messages from bob could not be decrypted]']);

    // It ends with the first failure newer than the notice.
    await h.process([h.junk(BOB, T + 1)]);
    expect(await h.bodies(BOB)).toEqual(['[65 messages from bob could not be decrypted]']);
  });

  it('undercounts an envelope listed after one with a newer created_at', async () => {
    const h = await harness();
    h.later();
    const T = Date.UTC(2026, 10, 13, 11, 0, 0);
    // The server takes created_at before it locks the mailbox and assigns the id inside the lock, so a
    // concurrent POST can get the earlier id with the later created_at.
    const listedFirst = h.junk(BOB, T + 5);
    const listedSecond = h.junk(BOB, T);
    await h.process([listedFirst]);
    h.restart();
    await h.process([listedSecond]);

    expect(await h.bodies(BOB)).toEqual(['[A message from bob could not be decrypted]']);
  });

  it('counts redelivered envelopes again when such an inversion straddles the end of a run', async () => {
    const h = await harness();
    h.later();
    const T = Date.UTC(2026, 10, 13, 11, 0, 0);
    // Both notices are inserted while one page is applied: same sort_ts, so compare them sorted.
    const notices = async () => (await h.notices(BOB)).map((m) => m.body).sort();
    const page = [h.junk(BOB, T + 5), h.message(BOB, 'readable'), h.junk(BOB, T)];
    await h.process(page);
    expect(await notices()).toEqual([
      'A message from bob could not be decrypted',
      'A message from bob could not be decrypted',
    ]);
    // Applied but not acked. After the restart the first envelope looks newer than the open notice (which
    // counted the later-listed, older one), and once that notice changed, nothing is taken as redelivered.
    h.restart();
    await h.process(page);

    expect(await notices()).toEqual([
      '3 messages from bob could not be decrypted',
      'A message from bob could not be decrypted',
    ]);
  });
});

describe('undecryptable notice text', () => {
  it('reads back the count it writes, and nothing from other system messages', () => {
    for (const [name, count] of [['bob', 1], ['bob', 2], ['B0b_99', 1000], ['2fast', 12]] as const) {
      expect(undecryptableCount(undecryptableText(name, count))).toBe(count);
    }
    expect(undecryptableText('bob')).toBe('A message from bob could not be decrypted');
    expect(undecryptableText('bob', 1000)).toBe('1000 messages from bob could not be decrypted');
    expect(undecryptableCount("bob's safety code changed")).toBeNull();
  });
});
