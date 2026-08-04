import { randomBytes } from 'node:crypto';

/** Environment configuration, read once at startup so the rest is pure. */

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  env: process.env['NODE_ENV'] ?? 'development',
  host: process.env['HOST'] ?? '0.0.0.0',
  port: num(process.env['PORT'], 3001),
  /** Origins allowed to reach the API and WebSocket. */
  corsOrigins: (process.env['CORS_ORIGIN'] ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  /** Serve the built web client from the API process (single-container prod). */
  staticDir: process.env['STATIC_DIR'] ?? null,
  /**
   * Directory of card images, served at `/cards`. 448 files of ~260 KB, so
   * they are served as static files rather than bundled into the client.
   */
  cardDir: process.env['CARD_DIR'] ?? null,
  /** Postgres connection string. Without it, deck storage is unavailable. */
  databaseUrl: process.env['DATABASE_URL'] ?? null,
  /**
   * Whether new accounts may be created. DesignNotes 1 asks for this to be a
   * deployment switch, so a server can be opened or closed without a rebuild.
   */
  registrationEnabled: (process.env['REGISTRATION_ENABLED'] ?? 'true').toLowerCase() !== 'false',
  /**
   * Signs session tokens. A random secret each boot is fine for development —
   * it just signs everyone out on restart — but production must set this, or
   * a restart invalidates every session.
   */
  sessionSecret: process.env['SESSION_SECRET'] ?? randomBytes(32).toString('hex'),
  /**
   * Accounts promoted to operator on boot, by username.
   *
   * There has to be *some* way to make the first admin without hand-editing
   * the database, and an environment variable is the same lever the rest of
   * the deployment already pulls. Promotion is one-way here: removing a name
   * does not demote anyone, because that would make a restart a security
   * event. Demote by clearing the flag in the database.
   */
  adminUsers: (process.env['ADMIN_USERS'] ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean),
} as const;

export const isProduction = config.env === 'production';
