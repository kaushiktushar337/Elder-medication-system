CREATE INDEX doses_pending_reminders ON doses(due)
  WHERE demo = 0 AND cancelled = 0 AND taken_at IS NULL AND claimed_at IS NULL;
CREATE INDEX doses_refill_consumption ON doses(medication, taken_at)
  WHERE demo = 0 AND cancelled = 0 AND taken_at IS NOT NULL;
