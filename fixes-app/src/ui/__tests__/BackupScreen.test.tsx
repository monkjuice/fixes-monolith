import { act, cleanup, fireEvent, screen } from '@testing-library/react-native';

import { toBase64 } from '../../core/crypto/encoding';
import { generateIdentityKeyPair } from '../../core/crypto/identity';
import { createTestPhone, FakeFixesServer, randomTestPassword, type TestPhone } from '../../test-utils';
import { BackupScreen } from '../screens/settings/BackupScreen';
import { renderScreen, servicesOfPhone } from './support/renderScreen';

/**
 * The Backups screen on a real phone (BackupService + MemoryFileAdapter as the share sheet and
 * document picker): §4.3 recovery-key confirmation before the first export, showing the key again,
 * and an import with its summary, including a contact whose pinned key differs (§10).
 */

jest.setTimeout(30_000);

const SLOW = { timeout: 10_000 };
const RECOVERY_KEY = /^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/;
const phones: TestPhone[] = [];

afterEach(async () => {
  cleanup();
  for (const phone of phones.splice(0)) await phone.dispose();
});

async function setUp() {
  const server = new FakeFixesServer();
  const password = randomTestPassword();
  server.addUser('alice', password);
  const bob = server.addUser('bob', randomTestPassword());
  const phone = createTestPhone(server, { name: 'alice1' });
  phones.push(phone);
  await phone.login('alice', password);
  // Something worth backing up: a conversation with bob and his pinned identity key.
  const bobKey = toBase64(generateIdentityKeyPair().publicKey);
  await phone.store.transaction(async (tx) => {
    await tx.conversations.insertIfMissing({ peerUserId: bob.id, peerUsername: 'bob', peerAvatarUrl: null, lastActivityAt: 1 });
    await tx.contactIdentities.pinIfAbsent(bob.id, bobKey, 1);
  });
  renderScreen('Backup', BackupScreen, servicesOfPhone(phone));
  return { phone, bob };
}

async function press(testID: string) {
  const element = await screen.findByTestId(testID, {}, SLOW);
  await act(async () => {
    fireEvent.press(element);
  });
}

describe('Backups (§10)', () => {
  it('creates the recovery key, insists on its last group, then exports through the share sheet', async () => {
    const { phone } = await setUp();
    await press('backup-create');
    const recoveryKey = String((await screen.findByTestId('recovery-key', {}, SLOW)).props.children);
    expect(recoveryKey).toMatch(RECOVERY_KEY);
    const lastGroup = recoveryKey.split('-')[5];

    await press('backup-key-written');
    // The key is hidden while the user types its last group from memory/paper.
    expect(screen.queryByTestId('recovery-key')).toBeNull();
    const wrong = lastGroup === 'AAAA' ? 'BBBB' : 'AAAA';
    fireEvent.changeText(screen.getByTestId('backup-last-group'), wrong);
    await press('backup-confirm');
    expect(await screen.findByTestId('backup-confirm-error', {}, SLOW)).toHaveTextContent(
      'That is not the last group of your recovery key.',
    );
    // Nothing stored and nothing exported before the confirmation succeeds.
    expect(await phone.session.items.getBackupKey(phone.userId)).toBeNull();
    expect(phone.files.shared).toHaveLength(0);

    // "Show the key again" returns to the same key, not a new one.
    fireEvent.press(screen.getByRole('button', { name: 'Show the key again' }));
    expect(screen.getByTestId('recovery-key')).toHaveTextContent(recoveryKey);
    await press('backup-key-written');
    // Input is tolerant (§4.3): lower case and surrounding spaces are fine.
    fireEvent.changeText(screen.getByTestId('backup-last-group'), ` ${lastGroup.toLowerCase()} `);
    await press('backup-confirm');

    expect(await screen.findByTestId('backup-exported-summary', {}, SLOW)).toHaveTextContent(/1 conversation, 0 messages\.$/);
    expect(phone.files.shared).toHaveLength(1);
    expect(phone.files.shared[0].name).toMatch(/^fixes-backup-alice-\d{8}-\d{4}\.fixes$/);
    expect(await phone.session.items.getBackupKey(phone.userId)).toBe(recoveryKey);

    // Settings → show the key again.
    await press('backup-done');
    await press('backup-show-recovery-key');
    expect(await screen.findByTestId('recovery-key-again', {}, SLOW)).toHaveTextContent(recoveryKey);

    // A second export needs no confirmation any more.
    await press('backup-create');
    expect(await screen.findByTestId('backup-exported', {}, SLOW)).toBeOnTheScreen();
    expect(phone.files.shared).toHaveLength(2);
  });

  it('imports a backup with the recovery key and reports a conflicting safety code', async () => {
    const { phone, bob } = await setUp();
    await press('backup-create');
    const recoveryKey = String((await screen.findByTestId('recovery-key', {}, SLOW)).props.children);
    await press('backup-key-written');
    fireEvent.changeText(screen.getByTestId('backup-last-group'), recoveryKey.split('-')[5]);
    await press('backup-confirm');
    await screen.findByTestId('backup-exported', {}, SLOW);
    await press('backup-done');

    // Bob's key changes on this phone after the backup (he reset his identity and it was accepted).
    await act(async () => {
      await phone.store.contactIdentities.setPending(bob.id, toBase64(generateIdentityKeyPair().publicKey));
      await phone.store.contactIdentities.acceptPending(bob.id);
    });

    const file = phone.files.shared[0];
    phone.files.nextPick = { name: file.name, contents: file.contents };
    await press('backup-import');
    expect(await screen.findByTestId('backup-need-key', {}, SLOW)).toHaveTextContent(file.name, { exact: false });

    // A well-formed but wrong key changes nothing and lets the user try again.
    fireEvent.changeText(screen.getByTestId('backup-recovery-key'), '0000-0000-0000-0000-0000-0000');
    await press('backup-restore');
    expect(await screen.findByTestId('backup-import-error', {}, SLOW)).toHaveTextContent(
      'Wrong recovery key, or the backup is damaged. Nothing was changed.',
    );

    fireEvent.changeText(screen.getByTestId('backup-recovery-key'), recoveryKey.toLowerCase());
    await press('backup-restore');
    expect(await screen.findByTestId('backup-imported-summary', {}, SLOW)).toHaveTextContent(
      'Everything in this backup was already on this phone.',
    );
    expect(await screen.findByTestId('backup-identity-conflicts', {}, SLOW)).toHaveTextContent(
      'The backup has a different safety code for bob.',
      { exact: false },
    );
  });
});
