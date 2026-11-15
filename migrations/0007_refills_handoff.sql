CREATE TABLE refills (
  medication TEXT PRIMARY KEY REFERENCES medications(id),
  snapshot TEXT UNIQUE NOT NULL,
  quantity INTEGER NOT NULL,
  threshold INTEGER NOT NULL,
  recorded_at BIGINT NOT NULL,
  contact TEXT REFERENCES members(id)
);
CREATE TABLE handoff_rules (
  profile TEXT PRIMARY KEY REFERENCES profiles(id),
  primary_member TEXT NOT NULL REFERENCES members(id),
  backup_member TEXT NOT NULL REFERENCES members(id),
  wait_minutes INTEGER NOT NULL
);
