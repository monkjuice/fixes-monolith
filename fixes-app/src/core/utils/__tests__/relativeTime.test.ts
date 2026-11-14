import { relativeTime } from '../relativeTime';

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const clock = { now: () => NOW };
const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

const ago = (ms: number) => relativeTime(NOW - ms, clock);

describe('relativeTime (legacy DateTimeUtils.RelativeTime thresholds and wording)', () => {
  it.each([
    [0, '0 seconds ago'],
    [999, '0 seconds ago'],
    [1 * S, '1 seconds ago'],
    [59 * S + 999, '59 seconds ago'],
    [60 * S, 'a minute ago'],
    [119 * S, 'a minute ago'],
    [120 * S, '2 minutes ago'],
    [44 * M + 59 * S, '44 minutes ago'],
    [45 * M, 'an hour ago'],
    [119 * M + 59 * S, 'an hour ago'],
    [120 * M, '2 hours ago'],
    [23 * H + 59 * M, '23 hours ago'],
    [24 * H, 'yesterday'],
    [47 * H + 59 * M, 'yesterday'],
    [2 * D, '2 days ago'],
    [29 * D + 23 * H, '29 days ago'],
    [30 * D, '1 months ago'],
    [59 * D, '1 months ago'],
    [60 * D, '2 months ago'],
    [364 * D, '12 months ago'],
    [365 * D, '1 years ago'],
    [729 * D, '1 years ago'],
    [730 * D, '2 years ago'],
    [3650 * D, '10 years ago'],
  ])('%p ms ago → %p', (elapsed, expected) => {
    expect(ago(elapsed)).toBe(expected);
  });

  it('shows timestamps from the future (clock skew) as "0 seconds ago"', () => {
    expect(ago(-5 * S)).toBe('0 seconds ago');
    expect(ago(-3 * D)).toBe('0 seconds ago');
  });

  it('uses the injected clock', () => {
    const then = NOW - 3 * H;
    expect(relativeTime(then, clock)).toBe('3 hours ago');
    expect(relativeTime(then, { now: () => NOW + 2 * D })).toBe('2 days ago');
  });
});
