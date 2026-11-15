import { DAY, IST, localDay, rows } from '../core.ts';

export async function refillLevels(env, profile = null, snapshot = null) {
  return rows(env, `SELECT r.*, m.profile, m.name, m.time, m.start_day, m.end_day,
    m.interval_days, m.skip_dates, m.effective,
    (SELECT COUNT(*) FROM doses d WHERE d.medication = m.id AND d.taken_at IS NOT NULL AND d.taken_at > r.recorded_at
      AND d.cancelled = 0 AND d.demo = 0) AS consumed
    FROM refills r JOIN medications m ON m.id = r.medication
    WHERE m.active = 1 AND (CAST(? AS TEXT) IS NULL OR m.profile = ?)
      AND (CAST(? AS TEXT) IS NULL OR r.snapshot = ?)`, profile, profile, snapshot, snapshot);
}

export const remaining = refill => Math.max(0, refill.quantity - refill.consumed);

export function refillForecast(refill, now) {
  const start = localDay(now);
  const [hour, minute] = refill.time.split(':').map(Number);
  let covered = remaining(refill);
  for (let i = 0; i < 366; i++) {
    const day = start + i * DAY;
    const due = day + (hour * 60 + minute) * 60_000;
    if (refill.end_day != null && day > refill.end_day) break;
    if (due <= now || due < refill.effective) continue;
    if (refill.start_day != null && (day < refill.start_day || ((day - refill.start_day) / DAY) % refill.interval_days !== 0)) continue;
    if (refill.skip_dates.includes('|' + new Date(day + IST).toISOString().slice(0, 10) + '|')) continue;
    if (covered === 0) return due;
    covered--;
  }
  return null;
}
