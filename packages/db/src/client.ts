import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export interface DbHandle {
  db: Db;
  sql: postgres.Sql;
  close: () => Promise<void>;
}

export function createDb(url: string, opts: { max?: number; appName?: string } = {}): DbHandle {
  const sql = postgres(url, {
    max: opts.max ?? 10,
    onnotice: () => {},
    connection: { application_name: opts.appName ?? 'mopay' },
    // numeric(78,0) comes back as string; drizzle maps it to bigint for mode:'bigint' columns.
  });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}
