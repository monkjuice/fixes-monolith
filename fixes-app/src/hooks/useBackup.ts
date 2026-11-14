import { useCallback, useMemo, useState } from 'react';

import {
  BackupError,
  type BackupErrorCode,
  type BackupFileHandle,
  type ExportResult,
  type ImportReport,
} from '../core/backup/backupService';
import { useFixes } from './FixesContext';

/**
 * - `confirmKey`: first export; show `recoveryKey` and ask for its last group;
 * - `needKey`: a backup file was picked and checked; ask for the recovery key.
 */
export type BackupStep = 'idle' | 'working' | 'confirmKey' | 'exported' | 'needKey' | 'imported';

export interface BackupFlowState {
  step: BackupStep;
  recoveryKey: string | null;
  file: BackupFileHandle | null;
  exported: ExportResult | null;
  imported: ImportReport | null;
  error: { code: BackupErrorCode | 'unexpected'; message: string } | null;
}

const IDLE: BackupFlowState = { step: 'idle', recoveryKey: null, file: null, exported: null, imported: null, error: null };

function toError(error: unknown): BackupFlowState['error'] {
  if (error instanceof BackupError) return { code: error.code, message: error.message };
  console.error('Backup failed', error);
  return { code: 'unexpected', message: 'Something went wrong. Please try again.' };
}

export interface BackupFlow extends BackupFlowState {
  /** Export: asks for confirmation of a new recovery key first, then opens the share sheet. */
  startExport(): Promise<void>;
  confirmRecoveryKey(lastGroup: string): Promise<void>;
  /** Import: opens the document picker and checks the file. */
  startImport(): Promise<void>;
  submitRecoveryKey(recoveryKey: string): Promise<void>;
  /** Settings → show the recovery key again (null before the first export). */
  viewRecoveryKey(): Promise<string | null>;
  reset(): void;
}

/** The export/import flows of §10 as a small state machine for the Backups screen. */
export function useBackup(): BackupFlow {
  const { backup } = useFixes();
  const [state, setState] = useState<BackupFlowState>(IDLE);

  const exportNow = useCallback(async () => {
    const exported = await backup.exportBackup();
    setState({ ...IDLE, step: 'exported', exported });
  }, [backup]);

  const startExport = useCallback(async () => {
    setState({ ...IDLE, step: 'working' });
    try {
      const prep = await backup.beginExport();
      if (prep.needsConfirmation) {
        setState({ ...IDLE, step: 'confirmKey', recoveryKey: prep.recoveryKey });
        return;
      }
      await exportNow();
    } catch (error) {
      setState({ ...IDLE, error: toError(error) });
    }
  }, [backup, exportNow]);

  const confirmRecoveryKey = useCallback(
    async (lastGroup: string) => {
      try {
        await backup.confirmRecoveryKey(lastGroup);
      } catch (error) {
        // Stay on the confirmation step so the user can type again.
        setState((s) => ({ ...s, error: toError(error) }));
        return;
      }
      setState((s) => ({ ...s, step: 'working', error: null }));
      try {
        await exportNow();
      } catch (error) {
        setState({ ...IDLE, error: toError(error) });
      }
    },
    [backup, exportNow],
  );

  const startImport = useCallback(async () => {
    setState({ ...IDLE, step: 'working' });
    try {
      const file = await backup.openBackupFile();
      setState(file ? { ...IDLE, step: 'needKey', file } : IDLE);
    } catch (error) {
      setState({ ...IDLE, error: toError(error) });
    }
  }, [backup]);

  const submitRecoveryKey = useCallback(
    async (recoveryKey: string) => {
      const file = state.file;
      if (!file) return;
      setState((s) => ({ ...s, step: 'working', error: null }));
      try {
        const imported = await backup.importBackup(file, recoveryKey);
        setState({ ...IDLE, step: 'imported', imported });
      } catch (error) {
        // A wrong key changes nothing: let the user try again with the same file.
        setState((s) => ({ ...s, step: 'needKey', error: toError(error) }));
      }
    },
    [backup, state.file],
  );

  const viewRecoveryKey = useCallback(() => backup.getRecoveryKey(), [backup]);

  const reset = useCallback(() => {
    backup.discardPendingKey();
    setState(IDLE);
  }, [backup]);

  return useMemo(
    () => ({ ...state, startExport, confirmRecoveryKey, startImport, submitRecoveryKey, viewRecoveryKey, reset }),
    [state, startExport, confirmRecoveryKey, startImport, submitRecoveryKey, viewRecoveryKey, reset],
  );
}
