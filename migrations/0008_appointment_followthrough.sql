ALTER TABLE appointment_requests ADD COLUMN questions TEXT NOT NULL DEFAULT '';
ALTER TABLE appointment_requests ADD COLUMN proposed_due BIGINT;
ALTER TABLE appointment_requests ADD COLUMN proposed_at BIGINT;
ALTER TABLE appointment_requests ADD COLUMN proposal_state TEXT CHECK (proposal_state IN ('pending', 'accepted', 'declined'));
ALTER TABLE appointment_requests ADD COLUMN visit_summary TEXT NOT NULL DEFAULT '';
ALTER TABLE appointment_requests ADD COLUMN summarized_at BIGINT;
ALTER TABLE medications ADD COLUMN updated_by TEXT;
