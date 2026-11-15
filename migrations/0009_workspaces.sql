ALTER TABLE accounts ADD COLUMN workspace TEXT NOT NULL DEFAULT 'family' CHECK (workspace IN ('family', 'doctor'));
ALTER TABLE members ADD COLUMN invited_account TEXT REFERENCES accounts(id);
CREATE INDEX invitation_recipient ON members(invited_account);
