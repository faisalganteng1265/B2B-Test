import postgres from 'postgres';
import { createDb, type DbHandle } from './client';
import { runMigrations } from './migrate';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/mopay_test';

/** Drop everything in the test database and re-apply migrations. */
export async function resetTestDb(url = TEST_DATABASE_URL): Promise<DbHandle> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  await sql.unsafe(
    'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;',
  );
  await sql.end();
  await runMigrations(url);
  return createDb(url, { max: 10, appName: 'test' });
}
