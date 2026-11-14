import { useCallback, useEffect, useState } from 'react';

export interface ApiQuery<T> {
  data: T | null;
  loading: boolean;
  error: unknown;
  /** Runs the request again (pull to refresh, "Retry"). */
  reload(): void;
}

interface State<T> {
  data: T | null;
  loading: boolean;
  error: unknown;
}

/**
 * Loads server data for a screen (e.g. the friends list). `load` must be stable (useCallback); a new
 * `load` or `reload()` starts a new request and results of superseded requests are ignored.
 */
export function useApiQuery<T>(load: () => Promise<T>): ApiQuery<T> {
  const [state, setState] = useState<State<T>>({ data: null, loading: true, error: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    load().then(
      (data) => {
        if (current) setState({ data, loading: false, error: null });
      },
      (error: unknown) => {
        // Kept in state for the screen to show (with a Retry button); previous data stays visible.
        if (current) setState((previous) => ({ ...previous, loading: false, error }));
      },
    );
    return () => {
      current = false;
    };
  }, [load, attempt]);

  const reload = useCallback(() => {
    setState((previous) => ({ ...previous, loading: true, error: null }));
    setAttempt((n) => n + 1);
  }, []);

  return { ...state, reload };
}
