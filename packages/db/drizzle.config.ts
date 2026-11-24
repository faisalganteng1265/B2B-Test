import { defineConfig } from 'drizzle-kit';
import { envFields, loadEnv } from '@mopay/config';

const env = loadEnv({ DATABASE_URL: envFields.DATABASE_URL });

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: env.DATABASE_URL },
  strict: true,
});
