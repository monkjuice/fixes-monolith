import { waitFor } from '../../../test-utils';
import { generateIdentityKeyPair } from '../../crypto/identity';
import { toBase64 } from '../../crypto/encoding';
import { uuidv4 } from '../../crypto/random';
import type { MessageRow } from '../../db/types';
import { FileAccessError } from '../../platform';
import {
  addLinkedDevice,
  createWorld,
  disposePhones,
  messageOn,
  statusOn,
  type World,
} from '../../messaging/__tests__/world';
import type { TestPhone } from '../../../test-utils';
import { BackupError, BackupService } from '../backupService';
import { backupFileName } from '../fileName';

// Integration tests run several phones on real timers; leave room for slow machines.
jest.setTimeout(20_000);

afterEach(async () => {
  await disposePhones();
});

function outgoing(phone: TestPhone, peer: string, status: MessageRow['status'], serverTs: number | null): MessageRow {
  return {
    id: uuidv4(),
    peer_user_id: peer,
    direction: 'out',
    sender_user_id: phone.userId,
    body: `status ${status}`,
    sent_at: 1_700_000_000_000,
    server_ts: serverTs,
    sort_ts: serverTs ?? 1_700_000_000_000,
    received_at: null,
    status,
  };
}

/** Exports a backup from alice1 (confirming a new recovery key) and returns the key and file contents. */
async function exportFrom(phone: TestPhone): Promise<{ recoveryKey: string; contents: string; fileName: string }> {
  const prep = await phone.backup.beginExport();
  if (!prep.needsConfirmation) throw new Error('expected a new recovery key');
  await phone.backup.confirmRecoveryKey(prep.recoveryKey.slice(-4));
  const result = await phone.backup.exportBackup();
  const shared = phone.files.shared.at(-1)!;
  return { recoveryKey: prep.recoveryKey, contents: shared.contents, fileName: result.fileName };
}

async function worldWithHistory(): Promise<World & { hello: MessageRow; reply: MessageRow }> {
  const w = await createWorld({ secondDevices: false });
  const hello = await w.alice1.engine.sendMessage(w.bobId, 'hello bob');
  const reply = await w.bob1.engine.sendMessage(w.aliceId, 'hello alice');
  await waitFor(async () => (await statusOn(w.alice1, hello.id)) === 'delivered');
  await waitFor(async () => (await messageOn(w.alice1, reply.id)) !== null);
  return { ...w, hello, reply };
}

describe('backups (§4.3, §10)', () => {
  it('generates, confirms and stores the recovery key before the first export', async () => {
    const w = await worldWithHistory();
    const backup = w.alice1.backup;
    expect(await backup.getRecoveryKey()).toBeNull();
    const prep = await backup.beginExport();
    expect(prep).toMatchObject({ needsConfirmation: true });
    const key = (prep as { recoveryKey: string }).recoveryKey;
    expect(key).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/);
    // Asking again before confirming shows the same key; exporting is refused until confirmed.
    expect(await backup.beginExport()).toEqual(prep);
    await expect(backup.exportBackup()).rejects.toMatchObject({ code: 'no_recovery_key' });
    const wrong = key.slice(-4) === '0000' ? '1111' : '0000';
    await expect(backup.confirmRecoveryKey(wrong)).rejects.toMatchObject({ code: 'confirmation_mismatch' });
    // Typing is forgiving (case, O for 0, I/L for 1), like the recovery key input itself.
    await backup.confirmRecoveryKey(key.slice(-4).toLowerCase().replace(/0/g, 'o').replace(/1/g, 'l'));
    expect(await backup.getRecoveryKey()).toBe(key);
    expect(await backup.beginExport()).toEqual({ needsConfirmation: false });

    const result = await backup.exportBackup();
    expect(result).toMatchObject({ conversations: 1, messages: 2 });
    expect(result.fileName).toMatch(/^fixes-backup-alice-\d{8}-\d{4}\.fixes$/);
    const [shared] = w.alice1.files.shared;
    expect(shared).toMatchObject({ name: result.fileName, mimeType: 'application/octet-stream' });
    const file = JSON.parse(shared.contents);
    expect(file).toMatchObject({
      format: 'fixes-backup',
      version: 1,
      user_id: w.aliceId,
      kdf: { name: 'hkdf-sha256' },
      cipher: 'xchacha20poly1305',
    });
    expect(shared.contents).not.toContain('hello bob');
  });

  it('round-trips into another device with the §10 merge rules', async () => {
    const w = await worldWithHistory();
    const pending = outgoing(w.alice1, w.bobId, 'pending', null);
    const sentOnly = outgoing(w.alice1, w.bobId, 'sent', 1_700_000_000_500);
    await w.alice1.store.transaction(async (tx) => {
      await tx.messages.insertOrIgnore(pending);
      await tx.messages.insertOrIgnore(sentOnly);
    });
    const { recoveryKey, contents, fileName } = await exportFrom(w.alice1);
    const bobPin = (await w.alice1.store.contactIdentities.get(w.bobId))!.identity_key;

    // The new device already knows some of it, and pinned a different key for Bob.
    const alice2 = await addLinkedDevice(w.alice1, 'alice2', 'alice', w.password);
    const otherKey = toBase64(generateIdentityKeyPair().publicKey);
    await alice2.store.transaction(async (tx) => {
      await tx.conversations.insertIfMissing({ peerUserId: w.bobId, peerUsername: 'bob', peerAvatarUrl: null, lastActivityAt: 1 });
      await tx.messages.insertOrIgnore({ ...w.hello, status: 'read', server_ts: 5, sort_ts: 5, received_at: null });
      await tx.contactIdentities.pinIfAbsent(w.bobId, otherKey, 1);
      await tx.receiptHints.put(sentOnly.id, 'delivered', Date.now());
    });

    alice2.files.nextPick = { name: fileName, contents };
    const handle = await alice2.backup.openBackupFile();
    expect(handle).toMatchObject({ fileName, file: { user_id: w.aliceId } });
    const report = await alice2.backup.importBackup(handle!, recoveryKey.toLowerCase());
    expect(report).toMatchObject({
      conversationsAdded: 0,
      messagesAdded: 3,
      messagesUpdated: 0,
      contactsAdded: 0,
      skipped: 0,
      identityConflicts: [w.bobId],
    });
    expect(bobPin).not.toBe(otherKey);
    // Existing pin wins; existing higher status wins; pending becomes failed; incoming becomes read.
    expect((await alice2.store.contactIdentities.get(w.bobId))?.identity_key).toBe(otherKey);
    expect(await statusOn(alice2, w.hello.id)).toBe('read');
    expect(await statusOn(alice2, pending.id)).toBe('failed');
    expect(await statusOn(alice2, w.reply.id)).toBe('read');
    // Receipt hints are applied afterwards.
    expect(await statusOn(alice2, sentOnly.id)).toBe('delivered');
    const conversation = await alice2.store.conversations.get(w.bobId);
    expect(conversation?.unread_count).toBe(0);
    expect(conversation?.last_activity_at).toBe((await messageOn(alice2, w.reply.id))?.sort_ts);
    // Imported rows never enter the outbox and never produce receipts.
    expect(await alice2.store.outbox.count()).toBe(0);

    // Importing again changes nothing.
    alice2.files.nextPick = { name: fileName, contents };
    const again = await alice2.backup.importBackup((await alice2.backup.openBackupFile())!, recoveryKey);
    expect(again).toMatchObject({ messagesAdded: 0, messagesUpdated: 0, conversationsAdded: 0 });
  });

  it('a wrong recovery key gives a clear error and changes nothing', async () => {
    const w = await worldWithHistory();
    const { contents, fileName, recoveryKey } = await exportFrom(w.alice1);
    const alice2 = await addLinkedDevice(w.alice1, 'alice2', 'alice', w.password);
    alice2.files.nextPick = { name: fileName, contents };
    const handle = (await alice2.backup.openBackupFile())!;
    const wrongKey = recoveryKey.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
    await expect(alice2.backup.importBackup(handle, wrongKey)).rejects.toMatchObject({ code: 'wrong_recovery_key' });
    await expect(alice2.backup.importBackup(handle, 'not a key')).rejects.toMatchObject({ code: 'invalid_recovery_key' });
    expect(await alice2.store.conversations.listInbox()).toEqual([]);
    expect(await messageOn(alice2, w.hello.id)).toBeNull();
  });

  it("refuses another account's backup", async () => {
    const w = await worldWithHistory();
    const { contents, fileName, recoveryKey } = await exportFrom(w.alice1);
    w.bob1.files.nextPick = { name: fileName, contents };
    await expect(w.bob1.backup.openBackupFile()).rejects.toMatchObject({ code: 'wrong_account' });
    // Even with a handle obtained elsewhere, the import checks the owner again.
    w.alice1.files.nextPick = { name: fileName, contents };
    const handle = (await w.alice1.backup.openBackupFile())!;
    await expect(w.bob1.backup.importBackup(handle, recoveryKey)).rejects.toMatchObject({ code: 'wrong_account' });
  });

  it('refuses malformed or unsupported files before asking for the key', async () => {
    const w = await worldWithHistory();
    const { contents } = await exportFrom(w.alice1);
    const valid = JSON.parse(contents) as Record<string, unknown>;
    const cases: [unknown, string][] = [
      ['not json at all', 'invalid_file'],
      [{ ...valid, format: 'something-else' }, 'invalid_file'],
      [{ ...valid, version: 2 }, 'unsupported_version'],
      [{ ...valid, cipher: 'aes-256-gcm' }, 'unsupported_version'],
      [{ ...valid, kdf: { name: 'scrypt', salt: (valid.kdf as { salt: string }).salt } }, 'unsupported_version'],
      [{ ...valid, kdf: { name: 'hkdf-sha256', salt: 'AAAA' } }, 'invalid_file'],
      [{ ...valid, nonce: undefined }, 'invalid_file'],
      [{ ...valid, user_id: 'ALICE' }, 'invalid_file'],
      [{ ...valid, created_at: 'yesterday' }, 'invalid_file'],
      [[valid], 'invalid_file'],
    ];
    for (const [value, code] of cases) {
      w.alice1.files.nextPick = { name: 'x.fixes', contents: typeof value === 'string' ? value : JSON.stringify(value) };
      await expect(w.alice1.backup.openBackupFile()).rejects.toMatchObject({ code });
    }
  });

  it('reports picker and share-sheet problems as backup errors', async () => {
    const w = await worldWithHistory();
    w.alice1.files.nextPick = null;
    expect(await w.alice1.backup.openBackupFile()).toBeNull();
    w.alice1.files.nextPick = new FileAccessError('too_large', 'too large');
    await expect(w.alice1.backup.openBackupFile()).rejects.toBeInstanceOf(BackupError);
    w.alice1.files.nextPick = { name: 'big', contents: 'x'.repeat(100) };
    const small = new BackupService({
      context: () => ({ userId: w.alice1.userId, username: 'alice', store: w.alice1.store }),
      items: w.alice1.session.items,
      files: w.alice1.files,
      clock: w.alice1.clock,
      maxFileBytes: 10,
    });
    await expect(small.openBackupFile()).rejects.toMatchObject({ code: 'file_too_large' });
    await exportFrom(w.alice1);
    w.alice1.files.sharingAvailable = false;
    await expect(w.alice1.backup.exportBackup()).rejects.toMatchObject({ code: 'sharing_unavailable' });
  });

  it('names files fixes-backup-<username>-<YYYYMMDD-HHmm>.fixes in local time', () => {
    const at = new Date(2026, 10, 13, 9, 5).getTime();
    expect(backupFileName('alice_1', at)).toBe('fixes-backup-alice_1-20261113-0905.fixes');
    expect(() => backupFileName('../x', at)).toThrow(RangeError);
  });
});
