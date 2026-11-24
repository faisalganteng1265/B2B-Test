import { resolve } from 'node:path';
import { config } from 'dotenv';
import type { NextConfig } from 'next';

// Server-only settings (API_URL, ADMIN_TOKEN) come from the monorepo root .env.
config({ path: resolve(process.cwd(), '../../.env'), quiet: true });

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  turbopack: { root: resolve(process.cwd(), '../..') },
};
export default nextConfig;
