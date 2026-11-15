ALTER TABLE members ADD COLUMN invite_email TEXT;
ALTER TABLE members ADD COLUMN invite_expires BIGINT;
ALTER TABLE members ADD COLUMN declined_at BIGINT;
CREATE UNIQUE INDEX member_email_invite ON members(profile, invite_email)
  WHERE invite_email IS NOT NULL AND account IS NULL AND revoked = 0;
