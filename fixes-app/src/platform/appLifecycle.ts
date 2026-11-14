import { AppState, type AppStateStatus } from 'react-native';

/**
 * Calls `onForeground` whenever the app comes back to the foreground: the socket reconnects after a
 * 4409 replacement (§6) and the outbox worker runs (§13). Returns the unsubscribe function.
 */
export function onAppForeground(onForeground: () => void): () => void {
  let previous: AppStateStatus = AppState.currentState;
  const subscription = AppState.addEventListener('change', (next) => {
    if (next === 'active' && previous !== 'active') onForeground();
    previous = next;
  });
  return () => subscription.remove();
}
