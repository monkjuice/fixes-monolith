import { createContext, useContext, type ReactNode } from 'react';

import type { BackupService } from '../core/backup/backupService';
import type { MessagingEngine } from '../core/messaging/engine';
import type { SessionManager } from '../core/session/sessionManager';

/** The services the hooks read (the app passes getAppServices(); tests pass their own). */
export interface FixesServices {
  session: SessionManager;
  messaging: MessagingEngine;
  backup: BackupService;
}

const FixesContext = createContext<FixesServices | null>(null);

export function FixesProvider({ services, children }: { services: FixesServices; children: ReactNode }) {
  return <FixesContext.Provider value={services}>{children}</FixesContext.Provider>;
}

export function useFixes(): FixesServices {
  const services = useContext(FixesContext);
  if (!services) throw new Error('Fixes hooks must be used inside <FixesProvider>');
  return services;
}
