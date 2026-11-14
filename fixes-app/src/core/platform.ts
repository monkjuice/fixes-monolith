/**
 * Platform services that src/core depends on. src/core never imports react, react-native or expo-*:
 * the Expo app injects the implementations in src/platform, the Jest/e2e suites inject the Node ones in
 * src/test-utils. Randomness is the one exception: it always comes from the global
 * crypto.getRandomValues (polyfilled on React Native by react-native-get-random-values, protocol §2).
 */

/** Values that can be bound to SQL parameters. Booleans are deliberately excluded: store 0/1. */
export type SqlValue = string | number | null | Uint8Array;

export interface SqlRunResult {
  changes: number;
  lastInsertRowId: number;
}

/** Statement execution shared by a database connection and an open transaction. */
export interface SqlExecutor {
  /** Runs one or more statements without parameters and without results (DDL, PRAGMA). */
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params?: readonly SqlValue[]): Promise<SqlRunResult>;
  getAllAsync<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, params?: readonly SqlValue[]): Promise<T | null>;
}

export interface SqlDatabase extends SqlExecutor {
  /**
   * BEGIN, run `task`, COMMIT (ROLLBACK and rethrow on failure). Implementations need not be exclusive:
   * src/core/db/localStore.ts serialises every statement and transaction itself.
   */
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
  closeAsync(): Promise<void>;
}

/**
 * Opens the per-user SQLCipher database file `fixes-<user_id>.db` (protocol §12). The key handling
 * (secure storage, the restored-file-without-key rule) lives in core; the opener only touches files.
 */
export interface DatabaseOpener {
  /** Opens (creating if needed) the file and applies `keyHex` (64 lowercase hex chars) with PRAGMA key. */
  open(userId: string, keyHex: string): Promise<SqlDatabase>;
  exists(userId: string): Promise<boolean>;
  /** Renames the file (and its -wal/-shm/-journal siblings) aside so a fresh one can be created. */
  moveAside(userId: string): Promise<void>;
  /** Deletes the file, its siblings and any moved-aside copies. The database must be closed. */
  delete(userId: string): Promise<void>;
}

/** String key/value storage backed by the OS keychain/keystore. */
export interface SecureKeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

export interface WebSocketMessageEvent {
  data: unknown;
}

export interface WebSocketCloseEvent {
  code: number;
  reason: string;
}

/** The subset of the WHATWG WebSocket API that the realtime client uses. */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: WebSocketMessageEvent) => void) | null;
  onclose: ((event: WebSocketCloseEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export const WEBSOCKET_OPEN = 1;

export interface WebSocketFactory {
  create(url: string): WebSocketLike;
}

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** A local file to send as one multipart field. */
export interface UploadFile {
  /** Platform file reference: a file:// URI on React Native, a filesystem path in Node. */
  uri: string;
  name: string;
  type: string;
}

export interface HttpUploadRequest {
  url: string;
  method: 'PUT' | 'POST';
  headers: Record<string, string>;
  field: string;
  file: UploadFile;
  signal?: AbortSignal;
}

/** The parts of a fetch Response that the API client reads. */
export interface HttpResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** Multipart upload (avatar). Separate from fetch because React Native builds file parts from URIs. */
export interface HttpUpload {
  send(request: HttpUploadRequest): Promise<HttpResponseLike>;
}

/** A text file the user picked (backup import). */
export interface PickedFile {
  name: string;
  contents: string;
}

export class FileAccessError extends Error {
  readonly code: 'too_large' | 'unreadable' | 'sharing_unavailable';

  constructor(code: FileAccessError['code'], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FileAccessError';
    this.code = code;
  }
}

/**
 * User-visible files (backups, protocol §10). Backups never touch the Fixes server: they are written
 * to the cache directory and handed to the OS share sheet, and imported through the document picker.
 */
export interface FileAdapter {
  /**
   * Writes `contents` (UTF-8) as `name` in the cache directory, opens the share sheet for it and
   * deletes the cache copy once the sheet is dismissed (also when sharing fails).
   */
  shareFile(file: { name: string; contents: string; mimeType: string; dialogTitle?: string }): Promise<void>;
  /**
   * Lets the user pick any file (type `*\/*`), copied to the cache directory, and returns its UTF-8
   * text, refusing files larger than `maxBytes`. The cache copy is deleted. Null when cancelled.
   */
  pickFile(options: { maxBytes: number }): Promise<PickedFile | null>;
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<HttpResponseLike>;
