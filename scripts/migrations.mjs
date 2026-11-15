import { readFileSync } from 'node:fs';

export const migrations = ['0001_initial.sql', '0002_checkins.sql'].map((file, index) => ({
  version: index + 1,
  sql: readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8')
}));
