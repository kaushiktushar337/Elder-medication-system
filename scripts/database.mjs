import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function database(filename = ':memory:') {
  const sqlite = new DatabaseSync(filename);
  sqlite.exec('PRAGMA foreign_keys = ON');
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'profiles'").get()) {
    sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  }
  return {
    prepare(sql) {
      const query = sqlite.prepare(sql);
      return { bind: (...args) => ({
        first: async () => query.get(...args) ?? null,
        all: async () => ({ results: query.all(...args) }),
        run: async () => ({ meta: { changes: Number(query.run(...args).changes) } }),
        execute: () => query.run(...args)
      }) };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map(statement => statement.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  };
}
