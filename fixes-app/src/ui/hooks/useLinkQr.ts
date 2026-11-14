import { useCallback, useEffect, useState } from 'react';

import { useLinkTransfer } from '../../hooks';
import { describeError } from '../presentation/errors';

/**
 * The QR shown by a device that receives a link/history transfer (§9 step 2): created on mount (the
 * engine reuses the open transfer, so the code stays the same while it is valid) and again on
 * `newCode()` after an error or expiry. `created` turns true once the engine answered, so a screen can
 * tell the current transfer's state from one left over by an earlier transfer.
 */
export function useLinkQr() {
  const { incoming, createQr, cancelIncoming } = useLinkTransfer();
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState(false);
  const [request, setRequest] = useState(0);

  useEffect(() => {
    let current = true;
    createQr().then(
      () => {
        if (current) setCreated(true);
      },
      (caught: unknown) => {
        if (current) setError(describeError(caught));
      },
    );
    return () => {
      current = false;
    };
  }, [createQr, request]);

  const newCode = useCallback(() => {
    setError(null);
    setCreated(false);
    setRequest((n) => n + 1);
  }, []);

  return { incoming, error, created, newCode, cancelIncoming };
}
