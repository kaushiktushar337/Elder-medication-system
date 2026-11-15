import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refillForecast, remaining } from '../../src/features/refills.ts';
import { localDay, DAY } from '../../src/core.ts';

test('refill forecast handles skipped days, ended schedules and midnight in IST', () => {
  const now = Date.parse('2026-11-15T07:00:00+05:30');
  const refill = {
    quantity: 2, consumed: 0, time: '08:00', effective: 0,
    start_day: localDay(now), end_day: null, interval_days: 2, skip_dates: '|2026-11-17|'
  };
  assert.equal(refillForecast(refill, now), Date.parse('2026-11-21T08:00:00+05:30'));
  assert.equal(refillForecast({ ...refill, end_day: localDay(now) + 4 * DAY }, now), null);
  assert.equal(remaining({ quantity: 2, consumed: 5 }), 0);
  assert.equal(refillForecast({ ...refill, quantity: 0 }, now), Date.parse('2026-11-15T08:00:00+05:30'));
  assert.equal(localDay(Date.parse('2026-11-14T18:30:00Z')), localDay(now));
  assert.equal(refillForecast({ ...refill, quantity: 0, time: '00:00', interval_days: 1 },
    Date.parse('2026-11-15T00:00:00+05:30')), Date.parse('2026-11-16T00:00:00+05:30'));
});
