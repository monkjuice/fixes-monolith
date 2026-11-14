import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { backupContextFromSession, BackupService } from '../../src/core/backup/backupService';
import { resolveApiConfig, type ApiConfig } from '../../src/core/config';
import { toHex } from '../../src/core/crypto/encoding';
import { randomBytes } from '../../src/core/crypto/random';
import { MessagingEngine } from '../../src/core/messaging/engine';
import type { MessagingTimings } from '../../src/core/messaging/timings';
import { systemClock, type FetchLike, type WebSocketFactory, type WebSocketLike } from '../../src/core/platform';
import { SessionManager } from '../../src/core/session/sessionManager';
import {
  CapturingLogger,
  createNodeDatabaseOpener,
  fetchUpload,
  MemoryFileAdapter,
  MemorySecureStore,
  wsWebSocketFactory,
  type NodeDatabaseOpener,
} from '../../src/test-utils';

/**
 * Shared setup for the e2e suite (`npm run test:e2e`): a "phone" is a SessionManager with Node
 * adapters (in-memory secure storage, better-sqlite3 files in a temp dir, fetch, ws) pointed at a
 * real fixes-server. Credentials are random per run and never logged.
 */

export function e2eApiConfig(): ApiConfig {
  const url = process.env.FIXES_E2E_API_URL;
  if (!url) {
    throw new Error(
      'Set FIXES_E2E_API_URL to the base URL of a running fixes-server, e.g. http://127.0.0.1:8000 ' +
        '(fixes-server/scripts/e2e_server.py starts a throwaway one; see e2e/README.md)',
    );
  }
  return resolveApiConfig(url, { release: false });
}

/** Unique, valid username (≤ 30 chars of [A-Za-z0-9_]). */
export function uniqueUsername(prefix = 'e2e'): string {
  return `${prefix}_${toHex(randomBytes(8))}`.slice(0, 30);
}

/** Random password generated at runtime; tests must not print it. */
export function randomPassword(): string {
  return `pw_${toHex(randomBytes(12))}`;
}

/**
 * What a phone sent and received, for assertions on the wire. Deliberately minimal: method, path
 * and status of each request, recipients of envelope POSTs and the types of socket frames. Never
 * headers (tokens) or other bodies.
 */
export interface RequestRecord {
  method: string;
  /** Path without the query string. */
  path: string;
  status: number | null;
  /** POST /v1/envelopes only. */
  recipients?: string[];
  completeFor?: string[];
  /** GET /v1/envelopes only: ids of the envelopes in the response. */
  envelopeIds?: string[];
}

export interface FrameRecord {
  type: string;
  /** `envelope` frames: the pushed envelope's id. */
  envelopeId?: string;
}

export class Traffic {
  readonly requests: RequestRecord[] = [];
  readonly frames: FrameRecord[] = [];

  envelopePosts(): RequestRecord[] {
    return this.requests.filter((r) => r.method === 'POST' && r.path === '/v1/envelopes');
  }

  mailboxFetches(): RequestRecord[] {
    return this.requests.filter((r) => r.method === 'GET' && r.path === '/v1/envelopes');
  }

  pushedEnvelopeIds(): string[] {
    return this.frames.flatMap((f) => (f.type === 'envelope' && f.envelopeId ? [f.envelopeId] : []));
  }
}

function recordingFetch(traffic: Traffic): FetchLike {
  return async (url, init) => {
    const parsed = new URL(url);
    const record: RequestRecord = { method: init.method, path: parsed.pathname, status: null };
    if (record.method === 'POST' && record.path === '/v1/envelopes' && init.body) {
      const body = JSON.parse(init.body) as {
        envelopes: { recipient_device_id: string }[];
        complete_for_user_ids?: string[];
      };
      record.recipients = body.envelopes.map((e) => e.recipient_device_id);
      record.completeFor = body.complete_for_user_ids;
    }
    traffic.requests.push(record);
    const response = await globalThis.fetch(url, init);
    record.status = response.status;
    if (record.method !== 'GET' || record.path !== '/v1/envelopes' || response.status !== 200) return response;
    // Read once here and hand the same text to the client.
    const text = await response.text();
    const json = JSON.parse(text) as { envelopes?: { id: string }[] };
    record.envelopeIds = (json.envelopes ?? []).map((e) => e.id);
    return { status: response.status, headers: response.headers, text: async () => text };
  };
}

function recordFrame(traffic: Traffic, data: unknown): void {
  if (typeof data !== 'string') {
    traffic.frames.push({ type: '<binary>' });
    return;
  }
  try {
    const frame = JSON.parse(data) as { type?: unknown; envelope?: { id?: unknown } };
    traffic.frames.push({
      type: String(frame.type),
      envelopeId: typeof frame.envelope?.id === 'string' ? frame.envelope.id : undefined,
    });
  } catch {
    // The client reports non-JSON frames itself (protocolError); here it is only counted.
    traffic.frames.push({ type: '<invalid>' });
  }
}

function recordingSocketFactory(traffic: Traffic, inner: WebSocketFactory): WebSocketFactory {
  return {
    create(url): WebSocketLike {
      const socket = inner.create(url);
      let onmessage: WebSocketLike['onmessage'] = null;
      return {
        get readyState() {
          return socket.readyState;
        },
        get onopen() {
          return socket.onopen;
        },
        set onopen(handler) {
          socket.onopen = handler;
        },
        get onclose() {
          return socket.onclose;
        },
        set onclose(handler) {
          socket.onclose = handler;
        },
        get onerror() {
          return socket.onerror;
        },
        set onerror(handler) {
          socket.onerror = handler;
        },
        get onmessage() {
          return onmessage;
        },
        set onmessage(handler) {
          onmessage = handler;
          socket.onmessage = handler
            ? (event) => {
                recordFrame(traffic, event.data);
                handler(event);
              }
            : null;
        },
        send: (data) => socket.send(data),
        close: (code, reason) => socket.close(code, reason),
      };
    },
  };
}

export interface Phone {
  name: string;
  manager: SessionManager;
  secureStore: MemorySecureStore;
  databases: NodeDatabaseOpener;
  traffic: Traffic;
  /** Disposes the manager, closes its database and deletes the temp directory. */
  cleanup(): Promise<void>;
}

export function createPhone(config: ApiConfig = e2eApiConfig(), deviceName = 'e2e phone'): Phone {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixes-e2e-'));
  const secureStore = new MemorySecureStore();
  const databases = createNodeDatabaseOpener(dir);
  const traffic = new Traffic();
  const manager = new SessionManager({
    config,
    secureStore,
    databases,
    deviceName,
    upload: fetchUpload,
    fetch: recordingFetch(traffic),
  });
  return {
    name: deviceName,
    manager,
    secureStore,
    databases,
    traffic,
    async cleanup() {
      manager.dispose();
      const status = manager.getState().status;
      if (status === 'ready' || status === 'needsLink') await manager.getLocalStore().close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface MessagingPhone extends Phone {
  engine: MessagingEngine;
  backup: BackupService;
  files: MemoryFileAdapter;
  logger: CapturingLogger;
  /** The `ws` factory the engine uses, recording frames into `traffic` (for extra sockets in tests). */
  socketFactory: WebSocketFactory;
}

/** Short retry delays so a transient failure does not stall the suite; protocol values otherwise. */
export const E2E_TIMINGS: Partial<MessagingTimings> = {
  receiptDebounceMs: 100,
  outboxBackoff: { minMs: 200, maxMs: 2000 },
  receiveBackoff: { minMs: 200, maxMs: 2000 },
  transferCheckIntervalMs: 500,
};

/**
 * A phone with the messaging engine attached (socket over `ws`, short retry delays) and a backup
 * service writing to memory. The engine follows the session: it starts once the phone is linked or
 * waiting to be linked.
 */
export function createMessagingPhone(
  options: { deviceName?: string; timings?: Partial<MessagingTimings>; config?: ApiConfig } = {},
): MessagingPhone {
  const phone = createPhone(options.config ?? e2eApiConfig(), options.deviceName ?? 'e2e phone');
  const logger = new CapturingLogger();
  const socketFactory = recordingSocketFactory(phone.traffic, wsWebSocketFactory);
  const engine = new MessagingEngine({
    session: phone.manager,
    socketFactory,
    logger,
    timings: { ...E2E_TIMINGS, ...options.timings },
  });
  engine.attach();
  const files = new MemoryFileAdapter();
  const backup = new BackupService({
    context: () => backupContextFromSession(phone.manager),
    items: phone.manager.items,
    files,
    clock: systemClock,
    // Same wiring as the app (src/platform/services.ts).
    onImported: (peers) => {
      if (peers.length === 0) return;
      engine.refreshPeers({ force: true }).catch((error: unknown) => logger.warn('refreshPeers failed', error));
    },
  });
  return {
    ...phone,
    engine,
    backup,
    files,
    logger,
    socketFactory,
    async cleanup() {
      engine.detach();
      await phone.cleanup();
    },
  };
}
