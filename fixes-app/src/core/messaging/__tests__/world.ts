import {
  createTestPhone,
  FakeFixesServer,
  randomTestPassword,
  waitFor,
  type TestPhone,
  type TestPhoneOptions,
} from '../../../test-utils';
import type { MessageRow } from '../../db/types';

/** Alice and Bob with two linked devices each, friends, all engines connected. */
export interface World {
  server: FakeFixesServer;
  password: string;
  alice1: TestPhone;
  alice2: TestPhone;
  bob1: TestPhone;
  bob2: TestPhone;
  aliceId: string;
  bobId: string;
  phones: TestPhone[];
}

const created: TestPhone[] = [];

export function trackPhone(server: FakeFixesServer, options: TestPhoneOptions): TestPhone {
  const phone = createTestPhone(server, options);
  created.push(phone);
  return phone;
}

export async function disposePhones(): Promise<void> {
  for (const phone of created.splice(0)) await phone.dispose();
}

export async function connected(phone: TestPhone): Promise<void> {
  await waitFor(() => phone.engine.getState().connection === 'ready', { message: `${phone.name} connected` });
}

/** Logs in a second device of the same account that self-certifies with a copied AIK. */
export async function addLinkedDevice(primary: TestPhone, name: string, username: string, password: string): Promise<TestPhone> {
  const phone = trackPhone(primary.server, { name });
  phone.copyIdentityFrom(primary);
  await phone.login(username, password);
  await connected(phone);
  return phone;
}

export async function createWorld(options: { secondDevices?: boolean; timings?: TestPhoneOptions['timings'] } = {}): Promise<World> {
  const server = new FakeFixesServer();
  const password = randomTestPassword();
  const alice = server.addUser('alice', password);
  const bob = server.addUser('bob', password);
  server.makeFriends(alice.id, bob.id);
  const alice1 = trackPhone(server, { name: 'alice1', timings: options.timings });
  await alice1.login('alice', password);
  const bob1 = trackPhone(server, { name: 'bob1', timings: options.timings });
  await bob1.login('bob', password);
  await connected(alice1);
  await connected(bob1);
  const second = options.secondDevices !== false;
  const alice2 = second ? await addLinkedDevice(alice1, 'alice2', 'alice', password) : alice1;
  const bob2 = second ? await addLinkedDevice(bob1, 'bob2', 'bob', password) : bob1;
  return {
    server,
    password,
    alice1,
    alice2,
    bob1,
    bob2,
    aliceId: alice.id,
    bobId: bob.id,
    phones: second ? [alice1, alice2, bob1, bob2] : [alice1, bob1],
  };
}

/** Oldest first. */
export async function messagesOf(phone: TestPhone, peer: string): Promise<MessageRow[]> {
  return (await phone.store.messages.listPage(peer, { limit: 500 })).reverse();
}

export async function messageOn(phone: TestPhone, id: string): Promise<MessageRow | null> {
  return phone.store.messages.get(id);
}

export async function statusOn(phone: TestPhone, id: string): Promise<string | null> {
  return (await phone.store.messages.get(id))?.status ?? null;
}

export function noErrors(world: { phones: TestPhone[] }): void {
  for (const phone of world.phones) {
    expect(phone.logger.errors().map((e) => `${phone.name}: ${e.message} ${String(e.error)}`)).toEqual([]);
  }
}
