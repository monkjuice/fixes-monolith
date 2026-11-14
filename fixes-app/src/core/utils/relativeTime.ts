import { systemClock, type Clock } from '../platform';

/**
 * Port of legacy xamFixes `DateTimeUtils.RelativeTime` (protocol §14): same thresholds, same wording
 * (including "1 months ago"-style plurals), evaluated in order on whole elapsed seconds.
 *
 * Deliberate deviation: the legacy code printed the number of *days* in the months band
 * ("40 months ago" for 40 days) and "365 years ago" at exactly 365 days. Here the months band counts
 * 30-day months and the years band 365-day years.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Unit = 'seconds' | 'minutes' | 'hours' | 'days' | 'months' | 'years' | 'none';

const THRESHOLDS: readonly { below: number; template: string; unit: Unit }[] = [
  { below: 60, template: '{0} seconds ago', unit: 'seconds' },
  { below: 2 * MINUTE, template: 'a minute ago', unit: 'none' },
  { below: 45 * MINUTE, template: '{0} minutes ago', unit: 'minutes' },
  { below: 120 * MINUTE, template: 'an hour ago', unit: 'none' },
  { below: DAY, template: '{0} hours ago', unit: 'hours' },
  { below: 2 * DAY, template: 'yesterday', unit: 'none' },
  { below: 30 * DAY, template: '{0} days ago', unit: 'days' },
  { below: 365 * DAY, template: '{0} months ago', unit: 'months' },
  { below: Number.POSITIVE_INFINITY, template: '{0} years ago', unit: 'years' },
];

function count(seconds: number, unit: Unit): number {
  // Clock skew (a timestamp in the future) shows "0 seconds ago", as in the legacy app.
  const s = Math.max(0, seconds);
  switch (unit) {
    case 'seconds':
      return s;
    case 'minutes':
      return Math.floor(s / MINUTE);
    case 'hours':
      return Math.floor(s / HOUR);
    case 'days':
      return Math.floor(s / DAY);
    case 'months':
      return Math.floor(s / DAY / 30);
    case 'years':
      return Math.max(1, Math.floor(s / DAY / 365));
    case 'none':
      return 0;
  }
}

/** `timestampMs` is milliseconds since the Unix epoch (local DB timestamps). */
export function relativeTime(timestampMs: number, clock: Clock = systemClock): string {
  // C# `(now.Ticks - then.Ticks) / 10_000_000` truncates toward zero.
  const since = Math.trunc((clock.now() - timestampMs) / 1000);
  for (const { below, template, unit } of THRESHOLDS) {
    if (since < below) return template.replace('{0}', String(count(since, unit)));
  }
  return '';
}
