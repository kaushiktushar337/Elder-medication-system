import { checkPostgres } from '../src/db/postgres.mjs';

const { DATABASE_URL, SUPABASE_DB_CA, SUPABASE_TLS_MODE } = process.env;
if (!DATABASE_URL) {
  console.error('Set DATABASE_URL in the ignored .env file or your environment.');
  process.exitCode = 1;
} else {
  try {
    const initialized = await checkPostgres(DATABASE_URL, SUPABASE_DB_CA, SUPABASE_TLS_MODE);
    console.log(SUPABASE_TLS_MODE === 'require'
      ? 'Connected over TLS with certificate verification disabled.'
      : 'Connected over TLS with certificate verification enabled.');
    console.log(initialized
      ? 'The CareCircle migration table exists.'
      : 'The API will initialize the CareCircle schema when it starts.');
  } catch (error) {
    console.error('Database connection check failed (' + (error.code || error.name) + '). Check the connection settings.');
    process.exitCode = 1;
  }
}
