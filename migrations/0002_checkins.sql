ALTER TABLE doses ADD COLUMN claimed_member TEXT REFERENCES members(id);
ALTER TABLE doses ADD COLUMN completed_at BIGINT;
CREATE TABLE checkins (
  id TEXT PRIMARY KEY,
  profile TEXT NOT NULL REFERENCES profiles(id),
  requested_at BIGINT NOT NULL,
  claimed_member TEXT REFERENCES members(id),
  claimed_by TEXT,
  claimed_at BIGINT,
  completed_at BIGINT
);
CREATE UNIQUE INDEX one_open_checkin ON checkins(profile) WHERE completed_at IS NULL;
CREATE INDEX checkins_requested ON checkins(requested_at);
