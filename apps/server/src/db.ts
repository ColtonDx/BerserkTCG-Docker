import { Pool } from 'pg';
import { config } from './config.js';

/**
 * Postgres connection pool.
 *
 * The database is optional: without `DATABASE_URL` the server still runs and
 * serves matches, and only deck storage is unavailable. That keeps local
 * development and the tests free of a database dependency, and means a
 * database outage degrades the app rather than stopping it.
 */

let pool: Pool | null = null;

export function getPool(): Pool | null {
  if (!config.databaseUrl) return null;
  pool ??= new Pool({
    connectionString: config.databaseUrl,
    // A deck query is small and fast; a stuck connection should fail quickly
    // rather than hold a request open.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 10,
  });
  return pool;
}

export const databaseEnabled = (): boolean => getPool() !== null;

/** True if the database answers. Used by the health check. */
export async function databaseReady(): Promise<boolean> {
  const active = getPool();
  if (!active) return false;
  try {
    await active.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function closePool(): Promise<void> {
  const active = pool;
  pool = null;
  if (active) await active.end();
}
