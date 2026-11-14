import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { backupContextFromSession, BackupService } from '../core/backup/backupService';
import { resolveApiConfig } from '../core/config';
import { toHex } from '../core/crypto/encoding';
import { randomBytes } from '../core/crypto/random';
import type { LocalStore } from '../core/db/localStore';
import type { Logger } from '../core/logger';
import { MessagingEngine } from '../core/messaging/engine';
import type { MessagingTimings } from '../core/messaging/timings';
import type { Clock } from '../core/platform';
import { SecureKeys } from '../core/session/secureItems';
import { SessionManager } from '../core/session/sessionManager';
import type { FakeFixesServer } from './fakeServer';
import { MemoryFileAdapter } from './memoryFileAdapter';
import { MemorySecureStore } from './memorySecureStore';
import { createNodeDatabaseOpener, type NodeDatabaseOpener } from './nodeSqlite';
import { createStubFetch } from './stubFetch';

/**
 * A "phone" for integration tests: SessionManager + MessagingEngine + BackupService wired to Node
 * adapters (in-memory secure storage, better-sqlite3 files in a temp dir) and a FakeFixesServer.
 */

/** Real time plus an adjustable offset, so timers and timestamps stay consistent. */
export class TestClock implements Clock {
  private offset = 0;

  now(): number {
    return Date.now() + this.offset;
  }

  advance(ms: number): void {
    this.offset += ms;
  }
}

export interface LogEntry {
  level: 'warn' | 'error';
  message: string;
  error?: unknown;
}

/** Keeps engine logs out of the test output while letting tests assert on them. */
export class CapturingLogger implements Logger {
  readonly entries: LogEntry[] = [];

  warn(message: string, error?: unknown): void {
    this.entries.push({ level: 'warn', message, error });
  }

  error(message: string, error?: unknown): void {
    this.entries.push({ level: 'error', message, error });
  }

  errors(): LogEntry[] {
    return this.entries.filter((e) => e.level === 'error');
  }
}

/** Short delays so integration tests run in milliseconds (the protocol values are the defaults). */
export const FAST_TIMINGS: Partial<MessagingTimings> = {
  receiptDebounceMs: 25,
  outboxBackoff: { minMs: 20, maxMs: 200 },
  receiveBackoff: { minMs: 20, maxMs: 200 },
  transferCheckIntervalMs: 50,
  historyBatchSize: 20,
};

export interface TestPhone {
  readonly name: string;
  readonly server: FakeFixesServer;
  readonly session: SessionManager;
  readonly engine: MessagingEngine;
  readonly backup: BackupService;
  readonly files: MemoryFileAdapter;
  readonly secureStore: MemorySecureStore;
  readonly databases: NodeDatabaseOpener;
  readonly logger: CapturingLogger;
  readonly clock: TestClock;
  readonly store: LocalStore;
  readonly userId: string;
  readonly deviceId: string;
  login(username: string, password: string): Promise<void>;
  /** Copies another install's AIK so the next login self-certifies (a shortcut around linking). */
  copyIdentityFrom(other: TestPhone): void;
  /** Disposes the engine and session, closes the DB and deletes the temp directory. */
  dispose(): Promise<void>;
}

export interface TestPhoneOptions {
  name?: string;
  timings?: Partial<MessagingTimings>;
}

const API = resolveApiConfig('https://api.fixes.test', { release: true });

export function createTestPhone(server: FakeFixesServer, options: TestPhoneOptions = {}): TestPhone {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixes-phone-'));
  const clock = new TestClock();
  const logger = new CapturingLogger();
  const secureStore = new MemorySecureStore();
  const databases = createNodeDatabaseOpener(dir, () => clock.now());
  const files = new MemoryFileAdapter();
  const session = new SessionManager({
    config: API,
    secureStore,
    databases,
    deviceName: options.name ?? 'Test phone',
    fetch: createStubFetch(server.handle),
    clock,
  });
  const engine = new MessagingEngine({
    session,
    socketFactory: server.socketFactory,
    clock,
    logger,
    timings: { ...FAST_TIMINGS, ...options.timings },
  });
  engine.attach();
  const backup = new BackupService({
    context: () => backupContextFromSession(session),
    items: session.items,
    files,
    clock,
  });
  const phone: TestPhone = {
    name: options.name ?? 'phone',
    server,
    session,
    engine,
    backup,
    files,
    secureStore,
    databases,
    logger,
    clock,
    get store() {
      return session.getLocalStore();
    },
    get userId() {
      const active = session.getActiveDevice();
      if (!active) throw new Error(`${phone.name} is not signed in`);
      return active.userId;
    },
    get deviceId() {
      const active = session.getActiveDevice();
      if (!active) throw new Error(`${phone.name} is not signed in`);
      return active.deviceId;
    },
    async login(username, password) {
      await session.start();
      await session.login(username, password);
    },
    copyIdentityFrom(other) {
      const key = SecureKeys.identity(other.userId);
      const value = other.secureStore.items.get(key);
      if (!value) throw new Error(`${other.name} holds no identity`);
      secureStore.items.set(key, value);
    },
    async dispose() {
      engine.detach();
      session.dispose();
      try {
        await session.getLocalStore().close();
      } catch {
        // The session had no open database (signed out); nothing to close.
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return phone;
}

/** Random password generated at runtime (never printed). */
export function randomTestPassword(): string {
  return `pw_${toHex(randomBytes(12))}`;
}

/** Polls `predicate` (sync or async) until it holds. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; message?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${options.message ?? 'condition'}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Waits until nothing happens for `quietMs` (no new requests on the server). */
export async function waitForQuiet(server: FakeFixesServer, quietMs = 150, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  let last = server.requests.length;
  let since = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (server.requests.length !== last) {
      last = server.requests.length;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) {
      return;
    }
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for the server to become quiet');
  }
}
