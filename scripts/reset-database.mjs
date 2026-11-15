import { resetCarecircle } from '../src/db/postgres.mjs';

const { DATABASE_URL, SUPABASE_DB_CA, SUPABASE_TLS_MODE } = process.env;
if (!DATABASE_URL || process.argv[2] !== '--clear-carecircle') {
  console.error('A configured DATABASE_URL and --clear-carecircle are required.');
  process.exitCode = 1;
} else {
  try {
    const count = await resetCarecircle(DATABASE_URL, SUPABASE_DB_CA, SUPABASE_TLS_MODE);
    console.log(count ? 'Verified empty CareCircle tables: ' + count : 'No CareCircle data tables exist in the configured database.');
  } catch (error) {
    console.error('CareCircle reset failed (' + (error.code || error.name) + ').');
    process.exitCode = 1;
  }
}
