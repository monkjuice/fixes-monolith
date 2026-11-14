import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

function subscribe(listener: () => void): () => void {
  const subscription = AppState.addEventListener('change', listener);
  return () => subscription.remove();
}

// Only a known background/inactive state counts as hidden: at launch iOS can report 'unknown' while
// the app is already on screen, and treating that as hidden would delay read receipts.
function isActive(): boolean {
  const state = AppState.currentState;
  return state !== 'background' && state !== 'inactive';
}

/** Whether the app is in the foreground (messages on screen may count as read, §7.2). */
export function useAppActive(): boolean {
  return useSyncExternalStore(subscribe, isActive, isActive);
}
