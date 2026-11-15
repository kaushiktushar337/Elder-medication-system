CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, pass TEXT UNIQUE NOT NULL);
CREATE TABLE account_sessions (token TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(id), expires BIGINT NOT NULL);
ALTER TABLE members ADD COLUMN account TEXT REFERENCES accounts(id);
ALTER TABLE members ADD COLUMN relationship TEXT;
CREATE UNIQUE INDEX member_account_patient ON members(account, profile) WHERE account IS NOT NULL AND revoked = 0;
