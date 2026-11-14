import { useCallback, useState } from 'react';
import { Alert } from 'react-native';

import { NetworkError } from '../../core/api/errors';
import type { LogoutOutcome } from '../../core/messaging/engine';
import { useFixes } from '../../hooks';
import { describeError, NO_INTERNET } from '../presentation/errors';

export interface LogoutAction {
  logout(): void;
  busy: boolean;
  error: string | null;
}

function unsentText(remaining: number): string {
  const items = remaining === 1 ? '1 message or receipt' : `${remaining} messages or receipts`;
  return `${items} could not be sent yet. They stay on this phone and are sent the next time you log in here. Log out anyway?`;
}

export const UNDRAINED_TEXT =
  'Messages waiting for this phone on the server could not be received first. If you log out now, they are deleted and never reach this phone. Log out anyway?';

/**
 * §13 logout through the messaging engine: drains the mailbox and flushes the outbox first. When items
 * remain, or the mailbox could not be drained (messaging is not running, e.g. on the startup error
 * screen), the user confirms before logging out anyway. Logging out needs a connection.
 */
export function useLogout(): LogoutAction {
  const { messaging } = useFixes();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const attempt = useCallback(
    async (force: boolean): Promise<LogoutOutcome | null> => {
      setBusy(true);
      setError(null);
      try {
        return await messaging.logout({ force });
      } catch (caught) {
        setError(caught instanceof NetworkError ? `${NO_INTERNET}. Logging out needs a connection.` : describeError(caught));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [messaging],
  );

  const logout = useCallback(() => {
    void attempt(false).then((outcome) => {
      if (outcome?.status !== 'unsent' && outcome?.status !== 'undrained') return;
      const [title, text] =
        outcome.status === 'unsent'
          ? ['Unsent messages', unsentText(outcome.remaining)]
          : ['Messages not received', UNDRAINED_TEXT];
      Alert.alert(title, text, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Log out', style: 'destructive', onPress: () => void attempt(true) },
      ]);
    });
  }, [attempt]);

  return { logout, busy, error };
}
