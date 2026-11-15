import pg from 'pg';
import { migrations } from './migrations.mjs';

const bigIntOid = 20;
const queryTypes = {
  getTypeParser(oid, format) {
    return oid === bigIntOid && format === 'text' ? Number : pg.types.getTypeParser(oid, format);
  }
};

function createPool(connectionString, ca, tlsMode = 'verify-full') {
  if (!['verify-full', 'require'].includes(tlsMode)) {
    throw new Error('SUPABASE_TLS_MODE must be verify-full or require.');
  }
  const url = new URL(connectionString);
  for (const parameter of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(parameter);
  const pool = new pg.Pool({
    connectionString: url.href,
    ssl: {
      rejectUnauthorized: tlsMode === 'verify-full',
      ...(tlsMode === 'verify-full' && ca ? { ca: ca.replaceAll('\\n', '\n') } : {})
    },
    max: 4,
    connectionTimeoutMillis: 10_000,
    types: queryTypes
  });
  pool.on('error', error => console.error('Database connection failed', error.code || error.name));
  return pool;
}

export async function checkPostgres(connectionString, ca, tlsMode) {
  const pool = createPool(connectionString, ca, tlsMode);
  try {
    const { rows: [result] } = await pool.query("SELECT to_regclass('carecircle.schema_migrations') IS NOT NULL AS initialized");
    return result.initialized;
  } finally {
    await pool.end();
  }
}

export async function resetCarecircle(connectionString, ca, tlsMode) {
  const pool = createPool(connectionString, ca, tlsMode);
  const tables = ['profiles', 'members', 'accounts', 'sessions', 'account_sessions', 'attempts', 'contacts', 'medications', 'appointments', 'doses', 'deliveries', 'checkins', 'appointment_requests'];
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(471230156)');
      const { rows } = await client.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'carecircle'");
      const existing = tables.filter(table => rows.some(row => row.tablename === table)).map(table => 'carecircle.' + table);
      if (existing.length) await client.query('TRUNCATE ' + existing.join(', ') + ' RESTRICT');
      for (const table of existing) {
        const { rows: [result] } = await client.query('SELECT COUNT(*) AS remaining FROM ' + table);
        if (Number(result.remaining) !== 0) throw new Error('CareCircle table was not cleared.');
      }
      await client.query('COMMIT');
      return existing.length;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

export async function postgres(connectionString, ca, tlsMode) {
  const pool = createPool(connectionString, ca, tlsMode);
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
    await transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(471230156)');
      await client.query('CREATE SCHEMA IF NOT EXISTS carecircle');
      await client.query('SET LOCAL search_path = carecircle');
      await client.query('REVOKE ALL ON SCHEMA carecircle FROM PUBLIC');
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)');
      const { rows } = await client.query('SELECT version FROM schema_migrations');
      const applied = new Set(rows.map(row => row.version));
      for (const { version, sql } of migrations) {
        if (applied.has(version)) continue;
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations VALUES ($1)', [version]);
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
