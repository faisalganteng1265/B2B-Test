import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { envFields, loadEnv } from '@mopay/config';
import { createDb } from './client';

export async function runMigrations(url: string) {
  const h = createDb(url, { max: 1, appName: 'migrate' });
  try {
    await migrate(h.db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  } finally {
    await h.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = loadEnv({ DATABASE_URL: envFields.DATABASE_URL });
  await runMigrations(env.DATABASE_URL);
  console.log('migrations applied');
}
