import { backupContextFromSession, BackupService } from '../core/backup/backupService';
import { MessagingEngine } from '../core/messaging/engine';
import { systemClock } from '../core/platform';
import { SessionManager } from '../core/session/sessionManager';
import { onAppForeground } from './appLifecycle';
import { loadApiConfig } from './config';
import { expoDatabaseOpener } from './database';
import { platformDeviceName } from './deviceName';
import { expoFileAdapter } from './fileAdapter';
import { nativeHttpUpload } from './httpUpload';
import { expoSecureStore } from './secureStore';
import { nativeWebSocketFactory } from './webSocket';

let sessionManager: SessionManager | null = null;

/**
 * App-wide SessionManager wired to the Expo adapters. A module singleton (not React state) so that
 * remounts and StrictMode double effects never create a second session. Throws a ConfigError when
 * EXPO_PUBLIC_API_URL is missing or not allowed for this build.
 */
export function getAppSessionManager(): SessionManager {
  if (!sessionManager) {
    sessionManager = new SessionManager({
      config: loadApiConfig(),
      secureStore: expoSecureStore,
      databases: expoDatabaseOpener,
      deviceName: platformDeviceName(),
      upload: nativeHttpUpload,
    });
  }
  return sessionManager;
}

/** Everything the UI talks to (provided to React through FixesProvider in src/hooks). */
export interface AppServices {
  session: SessionManager;
  messaging: MessagingEngine;
  backup: BackupService;
}

let services: AppServices | null = null;

/**
 * The session plus the messaging engine (attached to it, following its state) and backups, as one
 * module singleton. Also forwards "app returned to the foreground" to the engine.
 */
export function getAppServices(): AppServices {
  if (!services) {
    const session = getAppSessionManager();
    const messaging = new MessagingEngine({ session, socketFactory: nativeWebSocketFactory });
    messaging.attach();
    const backup = new BackupService({
      context: () => backupContextFromSession(session),
      items: session.items,
      files: expoFileAdapter,
      clock: systemClock,
      // §10/§13: conversations created by an import get their names and avatars from the server.
      onImported: (peers) => {
        if (peers.length === 0) return;
        messaging.refreshPeers({ force: true }).catch((error: unknown) => {
          console.warn('Could not refresh peer profiles after an import', error);
        });
      },
    });
    onAppForeground(() => messaging.onForeground());
    services = { session, messaging, backup };
  }
  return services;
}

export { nativeWebSocketFactory } from './webSocket';
