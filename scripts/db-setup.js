// Applies database.sql to the configured PostgreSQL database.
// Usage (either works):
//   npm run db:setup
//   node --env-file=.env scripts/db-setup.js
//
// The script self-loads Backend_CRM/.env when DATABASE_URL isn't already in the
// environment, and parses DATABASE_URL into explicit connection fields so the
// password is always passed as a string (avoids the SASL "client password must
// be a string" error that occurs when the env var fails to load).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Minimal .env loader — only fills vars that aren't already set.
async function loadEnv() {
  if (process.env.DATABASE_URL) return;
  try {
    const raw = await readFile(join(__dirname, '..', '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1];
      if (process.env[key] !== undefined) continue;
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  } catch { /* no .env file — rely on the ambient environment */ }
}

function clientConfig() {
  const url = process.env.DATABASE_URL;
  if (!url || typeof url !== 'string') {
    throw new Error('DATABASE_URL is not set. Add it to Backend_CRM/.env or the environment.');
  }
  const useSsl = ['1', 'true', 'yes', 'on'].includes(String(process.env.PGSSL ?? 'true').toLowerCase())
    || /sslmode=require/.test(url);
  // Parse into explicit fields so the password is guaranteed to be a string.
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, '') || 'postgres',
    ssl: useSsl ? { rejectUnauthorized: false } : false,
  };
}

async function main() {
  await loadEnv();
  const sql = await readFile(join(__dirname, '..', 'database.sql'), 'utf8');
  const client = new pg.Client(clientConfig());
  await client.connect();
  try {
    await client.query(sql);
    // eslint-disable-next-line no-console
    console.log('✅ database.sql applied successfully');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('❌ db setup failed:', err.message);
  process.exit(1);
});
