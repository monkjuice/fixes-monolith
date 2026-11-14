import { isValidUsername } from '../utils/validation';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/**
 * `fixes-backup-<username>-<YYYYMMDD-HHmm>.fixes` (protocol §10), in the phone's local time because
 * the user picks the file by this name. Usernames are `[A-Za-z0-9_]`, so the name is path-safe.
 */
export function backupFileName(username: string, timestampMs: number): string {
  if (!isValidUsername(username)) throw new RangeError('Invalid username');
  const d = new Date(timestampMs);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `fixes-backup-${username}-${stamp}.fixes`;
}
