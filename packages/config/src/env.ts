import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/** Repo root = nearest ancestor containing pnpm-workspace.yaml. */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) throw new Error('repo root not found');
    dir = parent;
  }
}

let dotenvLoaded = false;
function ensureDotenv() {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  // Real env always wins over .env (quiet: dotenv v17 logs by default).
  loadDotenv({ path: join(repoRoot(), '.env'), quiet: true });
}

const csv = z.string().transform((s) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
);

/** Reusable env field schemas. Each service composes the ones it needs. */
export const envFields = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CHAIN: z.enum(['base-sepolia', 'base']).default('base-sepolia'),
  RPC_URLS: csv
    .pipe(z.array(z.url()).min(1))
    .default(['https://base-sepolia-rpc.publicnode.com', 'https://sepolia.base.org']),
  DATABASE_URL: z.string().default('postgres://postgres@localhost:5432/mopay'),
  RESTATE_INGRESS_URL: z.url().default('http://localhost:8080'),
  RESTATE_ADMIN_URL: z.url().default('http://localhost:9070'),
  MOBEE_URL: z.url().default('http://localhost:4100'),
  MOBEE_API_KEY: z.string().min(1).default('mopay-dev'),
  MOBEE_API_SECRET: z.string().min(8).default('dev-mobee-secret-change-me'),
  BIFAST_URL: z.url().default('http://localhost:4200'),
  BIFAST_API_KEY: z.string().min(1).default('pjp-dev-key'),
  BIFAST_WEBHOOK_SECRET: z.string().min(8).default('dev-bifast-secret-change-me'),
  API_URL: z.url().default('http://localhost:4000'),
  ADMIN_TOKEN: z.string().min(8).default('dev-admin-token'),
};

export function loadEnv<T extends z.ZodRawShape>(
  shape: T,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<z.ZodObject<T>> {
  ensureDotenv();
  const parsed = z.object(shape).safeParse(source);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${msg}`);
  }
  return parsed.data;
}
