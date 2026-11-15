ALTER TABLE accounts ADD COLUMN email TEXT;
ALTER TABLE accounts ADD COLUMN password_hash TEXT;
ALTER TABLE accounts ADD COLUMN kind TEXT NOT NULL DEFAULT 'care-team' CHECK (kind IN ('patient', 'care-team'));
UPDATE accounts SET kind = 'patient' WHERE EXISTS (
  SELECT 1 FROM members WHERE members.account = accounts.id AND members.role = 'owner'
);
CREATE UNIQUE INDEX account_email_unique ON accounts(email);
