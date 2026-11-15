import { DatabaseSync } from 'node:sqlite';
import { migrations } from './migrations.mjs';

export function database(filename = ':memory:') {
  const sqlite = new DatabaseSync(filename);
  sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
  try {
    sqlite.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)');
    if (sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'profiles'").get()) {
      sqlite.exec('INSERT OR IGNORE INTO schema_migrations VALUES (1)');
    }
    const applied = new Set(sqlite.prepare('SELECT version FROM schema_migrations').all().map(row => row.version));
    for (const { version, sql } of migrations) {
      if (applied.has(version)) continue;
      sqlite.exec(sql);
      sqlite.prepare('INSERT INTO schema_migrations VALUES (?)').run(version);
    }
    sqlite.exec('COMMIT');
  } catch (error) {
    sqlite.exec('ROLLBACK');
    sqlite.close();
    throw error;
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
