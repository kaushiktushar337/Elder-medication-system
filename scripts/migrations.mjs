import { readFileSync } from 'node:fs';

export const migrations = ['0001_initial.sql', '0002_checkins.sql', '0003_accounts.sql', '0004_login.sql', '0005_care_plans.sql', '0006_invites.sql'].map((file, index) => ({
  version: index + 1,
  sql: readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8')
}));
