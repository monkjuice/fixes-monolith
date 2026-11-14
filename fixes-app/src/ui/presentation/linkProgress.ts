import type { OutgoingLinkPhase, OutgoingLinkState } from '../../core/linking/outgoing';

const RUNNING: ReadonlySet<OutgoingLinkPhase> = new Set([
  'checking',
  'certifying',
  'sendingLink',
  'syncing',
  'preparing',
  'sendingHistory',
]);

/** The linked device is working on a link (§9 steps 3–4): keep the screen awake, do not leave silently. */
export function isOutgoingLinkRunning(phase: OutgoingLinkPhase): boolean {
  return RUNNING.has(phase);
}

/** What the linking device is doing, for the progress line. */
export function outgoingLinkText(state: OutgoingLinkState): string {
  switch (state.phase) {
    case 'idle':
      return '';
    case 'checking':
      return 'Checking the new device…';
    case 'certifying':
      return 'Certifying the new device…';
    case 'sendingLink':
      return 'Sending your security key…';
    case 'syncing':
      return 'Collecting your newest messages…';
    case 'preparing':
      return 'Preparing your history…';
    case 'sendingHistory':
      return state.totalChunks > 0
        ? `Sending your history… ${state.sentChunks} of ${state.totalChunks}`
        : 'Sending your history…';
    case 'done':
      return state.targetDeviceName ? `${state.targetDeviceName} is linked and has your history.` : 'The device is linked and has your history.';
    case 'failed':
      return state.error?.message ?? 'Linking failed.';
  }
}

/** 0…1 for the progress bar: the link steps count as the first 10 %, the history chunks as the rest. */
export function outgoingLinkProgress(state: OutgoingLinkState): number {
  switch (state.phase) {
    case 'checking':
    case 'certifying':
      return 0.02;
    case 'sendingLink':
      return 0.05;
    case 'syncing':
    case 'preparing':
      return 0.1;
    case 'sendingHistory':
      return state.totalChunks > 0 ? 0.1 + 0.9 * (state.sentChunks / state.totalChunks) : 0.1;
    case 'done':
      return 1;
    default:
      return 0;
  }
}
