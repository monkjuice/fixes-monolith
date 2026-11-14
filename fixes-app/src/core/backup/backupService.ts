import {
  decryptBackup,
  encryptBackup,
  formatRecoveryKey,
  generateRecoveryKey,
  parseBackupFile,
  parseRecoveryKey,
  recoveryKeyConfirmationGroup,
  type BackupFile,
} from '../crypto/backup';
import { CryptoError } from '../crypto/errors';
import type { LocalStore } from '../db/localStore';
import { PayloadError } from '../payloads/fields';
import { parseSnapshotBody } from '../payloads/snapshot';
import { FileAccessError, type Clock, type FileAdapter } from '../platform';
import type { SecureItems } from '../session/secureItems';
import { readSnapshot } from '../snapshot/export';
import { mergeSnapshot, type MergeResult } from '../snapshot/merge';
import { backupFileName } from './fileName';

/**
 * Encrypted backups (protocol §4.3, §10). Export: on first use generate the recovery key, have the
 * user confirm it (re-typing its last group), then encrypt the snapshot and hand the file to the share
 * sheet. Import: pick a file, check its header and owner, ask for the recovery key, decrypt (a wrong
 * key changes nothing) and merge in one transaction.
 */

export type BackupErrorCode =
  | 'not_signed_in'
  | 'no_recovery_key'
  | 'confirmation_mismatch'
  | 'invalid_file'
  | 'unsupported_version'
  | 'wrong_account'
  | 'invalid_recovery_key'
  | 'wrong_recovery_key'
  | 'file_too_large'
  | 'file_unreadable'
  | 'sharing_unavailable';

const MESSAGES: Record<BackupErrorCode, string> = {
  not_signed_in: 'Sign in to use backups.',
  no_recovery_key: 'Create and confirm a recovery key first.',
  confirmation_mismatch: 'That is not the last group of your recovery key.',
  invalid_file: 'This file is not a Fixes backup.',
  unsupported_version: 'This backup was made by a newer version of Fixes.',
  wrong_account: 'This backup belongs to another account.',
  invalid_recovery_key: 'A recovery key has 24 characters (0-9, A-Z without I, L, O, U).',
  wrong_recovery_key: 'Wrong recovery key, or the backup is damaged. Nothing was changed.',
  file_too_large: 'This file is too large to be a Fixes backup.',
  file_unreadable: 'The file could not be read.',
  sharing_unavailable: 'Sharing files is not available on this device.',
};

export class BackupError extends Error {
  readonly code: BackupErrorCode;

  constructor(code: BackupErrorCode, options?: { cause?: unknown }) {
    super(MESSAGES[code], options);
    this.name = 'BackupError';
    this.code = code;
  }
}

/** The signed-in account the backup belongs to. */
export interface BackupContext {
  userId: string;
  username: string;
  store: LocalStore;
}

/** The backup context of a session: signed in (ready or waiting to be linked) with an open database. */
export function backupContextFromSession(session: {
  getState(): { status: string; user: { username: string } | null };
  getActiveDevice(): { userId: string } | null;
  getLocalStore(): LocalStore;
}): BackupContext | null {
  const state = session.getState();
  const active = session.getActiveDevice();
  if (!active || !state.user || (state.status !== 'ready' && state.status !== 'needsLink')) return null;
  return { userId: active.userId, username: state.user.username, store: session.getLocalStore() };
}

export interface BackupServiceOptions {
  /** Throws (or returns null) when nobody is signed in with an open database. */
  context(): BackupContext | null;
  items: SecureItems;
  files: FileAdapter;
  clock: Clock;
  /** Conversations an import created: refresh their names/avatars (`GET /v1/users?ids=`). */
  onImported?(addedPeers: string[]): void;
  maxFileBytes?: number;
}

/** A picked backup whose header and owner were checked; decrypting it needs the recovery key. */
export interface BackupFileHandle {
  fileName: string;
  createdAt: string;
  file: BackupFile;
}

export type ExportPreparation = { needsConfirmation: false } | { needsConfirmation: true; recoveryKey: string };

export interface ExportResult {
  fileName: string;
  conversations: number;
  messages: number;
}

export type ImportReport = MergeResult;

const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const MIME_TYPE = 'application/octet-stream';

/** Same normalisation as recovery key input (§4.3): case-insensitive, `-`/spaces ignored, O→0, I/L→1. */
function normalizeGroup(text: string): string {
  return text.toUpperCase().replace(/[-\s]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

export class BackupService {
  // Generated but not confirmed yet; kept in memory only so an abandoned key is never stored.
  private pending: { userId: string; key: Uint8Array } | null = null;

  constructor(private readonly options: BackupServiceOptions) {}

  /** The stored recovery key, formatted (Settings → view it again), or null before the first export. */
  async getRecoveryKey(): Promise<string | null> {
    const { userId } = this.requireContext();
    const stored = await this.options.items.getBackupKey(userId);
    if (stored === null) return null;
    return formatRecoveryKey(this.parseStoredKey(stored));
  }

  /** Step 1 of an export: a key exists, or a new one is generated and must be confirmed first. */
  async beginExport(): Promise<ExportPreparation> {
    const { userId } = this.requireContext();
    const stored = await this.options.items.getBackupKey(userId);
    if (stored !== null && this.isUsableKey(stored)) return { needsConfirmation: false };
    if (!this.pending || this.pending.userId !== userId) this.pending = { userId, key: generateRecoveryKey() };
    return { needsConfirmation: true, recoveryKey: formatRecoveryKey(this.pending.key) };
  }

  /** Step 2 (first export only): the user re-types the last group; then the key is stored. */
  async confirmRecoveryKey(typedLastGroup: string): Promise<void> {
    const { userId } = this.requireContext();
    const pending = this.pending;
    if (!pending || pending.userId !== userId) throw new BackupError('no_recovery_key');
    if (normalizeGroup(typedLastGroup) !== recoveryKeyConfirmationGroup(pending.key)) {
      throw new BackupError('confirmation_mismatch');
    }
    await this.options.items.setBackupKey(userId, formatRecoveryKey(pending.key));
    this.pending = null;
  }

  discardPendingKey(): void {
    this.pending = null;
  }

  /** Encrypts the current history and opens the share sheet for the file. */
  async exportBackup(): Promise<ExportResult> {
    const { userId, username, store } = this.requireContext();
    const stored = await this.options.items.getBackupKey(userId);
    if (stored === null) throw new BackupError('no_recovery_key');
    const recoveryKey = this.parseStoredKey(stored);
    const body = await readSnapshot(store);
    const now = this.options.clock.now();
    const file = encryptBackup({ userId, createdAt: new Date(now).toISOString(), body, recoveryKey });
    const fileName = backupFileName(username, now);
    try {
      await this.options.files.shareFile({
        name: fileName,
        contents: JSON.stringify(file),
        mimeType: MIME_TYPE,
        dialogTitle: 'Save your Fixes backup',
      });
    } catch (error) {
      if (error instanceof FileAccessError && error.code === 'sharing_unavailable') {
        throw new BackupError('sharing_unavailable', { cause: error });
      }
      throw error;
    }
    return { fileName, conversations: body.conversations.length, messages: body.messages.length };
  }

  /**
   * Picks a file and checks its header (format, version, cipher, kdf) and owner before the recovery
   * key is asked for. Null when the user cancelled the picker.
   */
  async openBackupFile(): Promise<BackupFileHandle | null> {
    const { userId } = this.requireContext();
    let picked;
    try {
      picked = await this.options.files.pickFile({ maxBytes: this.options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES });
    } catch (error) {
      if (error instanceof FileAccessError) {
        throw new BackupError(error.code === 'too_large' ? 'file_too_large' : 'file_unreadable', { cause: error });
      }
      throw error;
    }
    if (picked === null) return null;
    let json: unknown;
    try {
      json = JSON.parse(picked.contents);
    } catch (cause) {
      throw new BackupError('invalid_file', { cause });
    }
    const file = this.parseHeader(json);
    if (file.user_id !== userId) throw new BackupError('wrong_account');
    return { fileName: picked.name, createdAt: file.created_at, file };
  }

  /** Decrypts with the typed recovery key and merges (§10). A wrong key leaves the database untouched. */
  async importBackup(handle: BackupFileHandle, recoveryKeyText: string): Promise<ImportReport> {
    const { userId, store } = this.requireContext();
    if (handle.file.user_id !== userId) throw new BackupError('wrong_account');
    let recoveryKey: Uint8Array;
    try {
      recoveryKey = parseRecoveryKey(recoveryKeyText);
    } catch (cause) {
      throw new BackupError('invalid_recovery_key', { cause });
    }
    let body: unknown;
    try {
      body = decryptBackup(handle.file, recoveryKey, userId);
    } catch (error) {
      if (!(error instanceof CryptoError)) throw error;
      if (error.code === 'backup_user_mismatch') throw new BackupError('wrong_account', { cause: error });
      if (error.code === 'decrypt_failed') throw new BackupError('wrong_recovery_key', { cause: error });
      if (error.code === 'unsupported_backup') throw new BackupError('unsupported_version', { cause: error });
      throw new BackupError('invalid_file', { cause: error });
    }
    let snapshot;
    try {
      snapshot = parseSnapshotBody(body, userId);
    } catch (error) {
      if (error instanceof PayloadError) throw new BackupError('invalid_file', { cause: error });
      throw error;
    }
    const now = this.options.clock.now();
    const report = await store.transaction((tx) => mergeSnapshot(tx, snapshot, { me: userId, source: 'backup', now }));
    this.options.onImported?.(report.addedPeers);
    return report;
  }

  private parseHeader(json: unknown): BackupFile {
    try {
      return parseBackupFile(json);
    } catch (error) {
      if (error instanceof CryptoError) {
        throw new BackupError(error.code === 'unsupported_backup' ? 'unsupported_version' : 'invalid_file', { cause: error });
      }
      throw error;
    }
  }

  private isUsableKey(stored: string): boolean {
    try {
      parseRecoveryKey(stored);
      return true;
    } catch (error) {
      if (error instanceof CryptoError) return false;
      throw error;
    }
  }

  private parseStoredKey(stored: string): Uint8Array {
    try {
      return parseRecoveryKey(stored);
    } catch (cause) {
      // Only this app writes the item; a corrupt one is as good as none (a new key can be created).
      throw new BackupError('no_recovery_key', { cause });
    }
  }

  private requireContext(): BackupContext {
    const context = this.options.context();
    if (!context) throw new BackupError('not_signed_in');
    return context;
  }
}
