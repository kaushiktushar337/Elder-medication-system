ALTER TABLE medications ADD COLUMN start_day BIGINT;
ALTER TABLE medications ADD COLUMN end_day BIGINT;
ALTER TABLE medications ADD COLUMN interval_days INTEGER NOT NULL DEFAULT 1;
ALTER TABLE medications ADD COLUMN skip_dates TEXT NOT NULL DEFAULT '';
CREATE TABLE appointment_requests (
  id TEXT PRIMARY KEY,
  profile TEXT NOT NULL REFERENCES profiles(id),
  doctor TEXT NOT NULL REFERENCES members(id),
  name TEXT NOT NULL,
  requested_at BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'scheduled', 'declined', 'cancelled')),
  due BIGINT,
  location TEXT NOT NULL DEFAULT ''
);
CREATE INDEX appointment_requests_profile_status ON appointment_requests(profile, status);
CREATE UNIQUE INDEX appointment_requests_active ON appointment_requests(profile, doctor, name) WHERE status = 'pending';
