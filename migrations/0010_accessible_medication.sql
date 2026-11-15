ALTER TABLE appointment_requests ADD COLUMN proposal_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE appointments ADD COLUMN doctor TEXT REFERENCES members(id);
CREATE TABLE medication_photos (
  medication TEXT PRIMARY KEY REFERENCES medications(id),
  jpeg TEXT NOT NULL,
  revision TEXT NOT NULL
);
