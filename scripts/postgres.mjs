import { readFile } from 'node:fs/promises';
import pg from 'pg';

const bigIntOid = 20;
const queryTypes = {
  getTypeParser(oid, format) {
    return oid === bigIntOid && format === 'text' ? Number : pg.types.getTypeParser(oid, format);
  }
};

export async function postgres(connectionString, ca) {
  const url = new URL(connectionString);
  for (const parameter of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(parameter);
  const pool = new pg.Pool({
    connectionString: url.href,
    ssl: { rejectUnauthorized: true, ...(ca ? { ca: ca.replaceAll('\\n', '\n') } : {}) },
    max: 4,
    connectionTimeoutMillis: 10_000,
    types: queryTypes
  });
  pool.on('error', error => console.error('Database connection failed', error.code || error.name));

  const initialized = new WeakSet();
  async function connection(operation) {
    const client = await pool.connect();
    let broken = false;
    try {
      if (!initialized.has(client)) {
        await client.query('SET search_path = carecircle');
        initialized.add(client);
      }
      return await operation(client);
    } catch (error) {
      broken = !initialized.has(client);
      throw error;
    } finally {
      client.release(broken);
    }
  }
  const transaction = operation => connection(async client => {
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });

  try {
    const migration = await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
    await transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(471230156)');
      await client.query('CREATE SCHEMA IF NOT EXISTS carecircle');
      await client.query('SET LOCAL search_path = carecircle');
      await client.query('REVOKE ALL ON SCHEMA carecircle FROM PUBLIC');
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)');
      const existing = await client.query('SELECT 1 FROM schema_migrations WHERE version = 1');
      if (!existing.rowCount) {
        await client.query(migration);
        await client.query('INSERT INTO schema_migrations VALUES (1)');
      }
    });
  } catch (error) {
    await pool.end();
    throw error;
  }

  return { ...postgresQueries(connection, transaction), close: () => pool.end() };
}

export function postgresQueries(connection, transaction) {
  return {
    prepare(sql) {
      let index = 0;
      const statement = sql.replaceAll('?', () => '$' + ++index);
      return { bind: (...args) => {
        const execute = client => client
          ? client.query(statement, args)
          : connection(db => db.query(statement, args));
        return {
          execute,
          first: async () => (await execute()).rows[0] ?? null,
          all: async () => ({ results: (await execute()).rows }),
          run: async () => ({ meta: { changes: (await execute()).rowCount } })
        };
      } };
    },
    batch(statements) {
      return transaction(async client => {
        for (const statement of statements) await statement.execute(client);
      });
    }
  };
}
