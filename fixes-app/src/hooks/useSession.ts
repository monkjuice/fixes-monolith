import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { bytesEqual, fromBase64Exact, toBase64 } from '../core/crypto/encoding';
import type { LocalStore } from '../core/db/localStore';
import type { MessagingState } from '../core/messaging/engine';
import type { SessionState } from '../core/session/sessionManager';
import { useFixes } from './FixesContext';

/** The session state (status, user, device, offline, error…), re-rendering on every change. */
export function useSession(): SessionState {
  const { session } = useFixes();
  // SessionManager's methods are not bound; stable wrappers keep useSyncExternalStore from resubscribing.
  const subscribe = useCallback((listener: () => void) => session.subscribe(listener), [session]);
  const getSnapshot = useCallback(() => session.getState(), [session]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Engine status: connection, mailbox sync in progress, and the §13 gap banner flag. */
export function useMessagingState(): MessagingState {
  const { messaging } = useFixes();
  return useSyncExternalStore(messaging.subscribe, messaging.getState, messaging.getState);
}

export interface OwnIdentityKey {
  /** Secure storage has not been read yet. */
  loading: boolean;
  /** This install's AIK public key (base64), or null when it holds none. */
  publicKey: string | null;
  /** It is the key the server reports for the account (`user.identity_key`). */
  matchesAccount: boolean;
}

function sameKey(a: string | null, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  try {
    return bytesEqual(fromBase64Exact(a, 32), fromBase64Exact(b, 32));
  } catch {
    // A malformed key matches nothing.
    return false;
  }
}

/**
 * This install's AIK, read from secure storage (again whenever the session changes). Safety codes and
 * the "Linked" check use it, never the key the server reports (§4.4, §8): a server that substitutes its
 * own keys could otherwise make both users' codes match while it reads their messages.
 */
export function useOwnIdentityKey(): OwnIdentityKey {
  const { session } = useFixes();
  const state = useSession();
  const [publicKey, setPublicKey] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let current = true;
    session.getIdentity().then(
      (identity) => {
        if (current) setPublicKey(identity ? toBase64(identity.publicKey) : null);
      },
      (error: unknown) => {
        console.warn('Could not read the identity key', error);
        if (current) setPublicKey(null);
      },
    );
    return () => {
      current = false;
    };
  }, [session, state]);
  const own = publicKey ?? null;
  return { loading: publicKey === undefined, publicKey: own, matchesAccount: sameKey(own, state.user?.identity_key) };
}

/** The signed-in user's database, or null while no session is open (signed out, loading). */
export function useLocalStore(): LocalStore | null {
  const { session } = useFixes();
  const state = useSession();
  const open = state.status === 'ready' || state.status === 'needsLink';
  const userId = state.user?.id ?? null;
  return useMemo(() => {
    if (!open || userId === null) return null;
    try {
      return session.getLocalStore();
    } catch (error) {
      // The state says open but the database is not (a transition in progress): treat as closed.
      console.warn('Local database not available yet', error);
      return null;
    }
  }, [open, userId, session]);
}
