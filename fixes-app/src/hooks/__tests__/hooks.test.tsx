import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { uuidv4 } from '../../core/crypto/random';
import type { MessageRow } from '../../core/db/types';
import {
  createTestPhone,
  FakeFixesServer,
  randomTestPassword,
  waitFor as waitUntil,
  type TestPhone,
} from '../../test-utils';
import { FixesProvider } from '../FixesContext';
import { useBackup } from '../useBackup';
import { useContactIdentity, useConversations, useMessages } from '../useConversations';
import { useLinkTransfer } from '../useLinkTransfer';
import { useLocalStore, useMessagingState, useSession } from '../useSession';

jest.setTimeout(20_000);

const phones: TestPhone[] = [];

afterEach(async () => {
  for (const phone of phones.splice(0)) await phone.dispose();
});

function wrapperFor(phone: TestPhone) {
  const services = { session: phone.session, messaging: phone.engine, backup: phone.backup };
  return function Wrapper({ children }: { children: ReactNode }) {
    return <FixesProvider services={services}>{children}</FixesProvider>;
  };
}

async function pair() {
  const server = new FakeFixesServer();
  const password = randomTestPassword();
  const alice = server.addUser('alice', password);
  const bob = server.addUser('bob', password);
  server.makeFriends(alice.id, bob.id);
  const alicePhone = createTestPhone(server, { name: 'alice1' });
  const bobPhone = createTestPhone(server, { name: 'bob1' });
  phones.push(alicePhone, bobPhone);
  return { server, password, alice, bob, alicePhone, bobPhone };
}

async function ready(phone: TestPhone, username: string, password: string) {
  await phone.login(username, password);
  await waitUntil(() => phone.engine.getState().connection === 'ready');
}

describe('hooks', () => {
  it('useSession / useMessagingState / useLocalStore follow the session', async () => {
    const { alicePhone, password } = await pair();
    const { result } = renderHook(
      () => ({ session: useSession(), messaging: useMessagingState(), store: useLocalStore() }),
      { wrapper: wrapperFor(alicePhone) },
    );
    expect(result.current.session.status).toBe('loading');
    expect(result.current.store).toBeNull();
    await act(async () => {
      await ready(alicePhone, 'alice', password);
    });
    await waitFor(() => expect(result.current.messaging.connection).toBe('ready'));
    expect(result.current.session).toMatchObject({ status: 'ready', user: { username: 'alice' } });
    expect(result.current.store).toBe(alicePhone.store);
  });

  it('useConversations and useMessages re-query on changes and paginate', async () => {
    const { alicePhone, bobPhone, password, alice, bob } = await pair();
    await ready(alicePhone, 'alice', password);
    await ready(bobPhone, 'bob', password);
    const wrapper = wrapperFor(alicePhone);
    const inbox = renderHook(() => useConversations(), { wrapper });
    await waitFor(() => expect(inbox.result.current.loading).toBe(false));
    expect(inbox.result.current.data).toEqual([]);

    // 45 stored messages, read 20 at a time.
    await alicePhone.store.transaction(async (tx) => {
      await tx.conversations.insertIfMissing({ peerUserId: bob.id, peerUsername: 'bob', peerAvatarUrl: null, lastActivityAt: 1 });
      for (let i = 0; i < 45; i++) {
        const row: MessageRow = {
          id: uuidv4(),
          peer_user_id: bob.id,
          direction: 'in',
          sender_user_id: bob.id,
          body: `old ${i}`,
          sent_at: i,
          server_ts: 1000 + i,
          sort_ts: 1000 + i,
          received_at: 1,
          status: 'read',
        };
        await tx.messages.insertOrIgnore(row);
      }
    });
    await waitFor(() => expect(inbox.result.current.data.map((c) => c.last_body)).toEqual(['old 44']));

    const messages = renderHook(() => useMessages(bob.id, 20), { wrapper });
    await waitFor(() => expect(messages.result.current.messages).toHaveLength(20));
    expect(messages.result.current.messages[0].body).toBe('old 44');
    expect(messages.result.current.hasMore).toBe(true);
    act(() => messages.result.current.loadMore());
    await waitFor(() => expect(messages.result.current.messages).toHaveLength(40));
    act(() => messages.result.current.loadMore());
    await waitFor(() => expect(messages.result.current.messages).toHaveLength(45));
    expect(messages.result.current.hasMore).toBe(false);
    expect(messages.result.current.messages.at(-1)?.body).toBe('old 0');

    // A live message from Bob shows up at the top of both.
    await act(async () => {
      await bobPhone.engine.sendMessage(alice.id, 'live');
    });
    await waitFor(() => expect(messages.result.current.messages[0].body).toBe('live'));
    // The window holds three pages by now, so nothing older drops out.
    expect(messages.result.current.messages).toHaveLength(46);
    await waitFor(() => expect(inbox.result.current.data[0]).toMatchObject({ last_body: 'live', unread_count: 1 }));

    const identity = renderHook(() => useContactIdentity(bob.id), { wrapper });
    await waitFor(() => expect(identity.result.current.data?.user_id).toBe(bob.id));
  });

  it('useLinkTransfer exposes the new-device QR and the linking progress', async () => {
    const { server, password, alicePhone } = await pair();
    await ready(alicePhone, 'alice', password);
    const newPhone = createTestPhone(server, { name: 'alice2' });
    phones.push(newPhone);
    await newPhone.login('alice', password);
    await waitUntil(() => newPhone.engine.getState().connection === 'ready');

    const incoming = renderHook(() => useLinkTransfer(), { wrapper: wrapperFor(newPhone) });
    const outgoing = renderHook(() => useLinkTransfer(), { wrapper: wrapperFor(alicePhone) });
    let qr = '';
    await act(async () => {
      qr = await incoming.result.current.createQr();
    });
    expect(incoming.result.current.incoming).toMatchObject({ phase: 'waiting', qr });
    await act(async () => {
      await outgoing.result.current.startLink(qr);
    });
    expect(outgoing.result.current.outgoing.phase).toBe('done');
    await waitFor(() => expect(incoming.result.current.incoming.phase).toBe('complete'));
  });

  it('useBackup walks through export (with key confirmation) and import (wrong key, then right)', async () => {
    const { password, alicePhone } = await pair();
    await ready(alicePhone, 'alice', password);
    const { result } = renderHook(() => useBackup(), { wrapper: wrapperFor(alicePhone) });

    await act(async () => {
      await result.current.startExport();
    });
    expect(result.current.step).toBe('confirmKey');
    const key = result.current.recoveryKey!;
    await act(async () => {
      await result.current.confirmRecoveryKey(key.slice(-4) === '0000' ? '1111' : '0000');
    });
    expect(result.current).toMatchObject({ step: 'confirmKey', error: { code: 'confirmation_mismatch' } });
    await act(async () => {
      await result.current.confirmRecoveryKey(key.slice(-4));
    });
    expect(result.current.step).toBe('exported');
    expect(result.current.exported?.fileName).toMatch(/^fixes-backup-alice-/);
    expect(await result.current.viewRecoveryKey()).toBe(key);

    alicePhone.files.nextPick = { name: 'backup.fixes', contents: alicePhone.files.shared[0].contents };
    await act(async () => {
      await result.current.startImport();
    });
    expect(result.current.step).toBe('needKey');
    await act(async () => {
      await result.current.submitRecoveryKey('0000-0000-0000-0000-0000-0000');
    });
    expect(result.current).toMatchObject({ step: 'needKey', error: { code: 'wrong_recovery_key' } });
    await act(async () => {
      await result.current.submitRecoveryKey(key);
    });
    expect(result.current).toMatchObject({ step: 'imported', error: null, imported: { messagesAdded: 0 } });
    act(() => result.current.reset());
    expect(result.current.step).toBe('idle');
  });
});
