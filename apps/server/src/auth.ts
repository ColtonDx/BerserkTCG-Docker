import {
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { config } from './config.js';
import { getPool } from './db.js';

/**
 * Accounts and sessions. DesignNotes 1.
 *
 * Passwords are hashed with scrypt, which is in Node's standard library and
 * memory-hard — no dependency, and no fast GPU attack on a stolen dump. The
 * parameters are stored alongside each hash so they can be raised later
 * without invalidating existing passwords.
 *
 * Sessions are signed tokens rather than rows: nothing to look up on each
 * request, and nothing to clean up. The trade is that a token cannot be
 * revoked before it expires, which is acceptable while sessions are short.
 * If revocation is needed, this is where a session table goes.
 */

/** Promisified scrypt. Wrapped by hand because `promisify` drops the options overload. */
const scrypt = (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });

// Cost parameters. N is the work factor; raising it makes every hash slower.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 } as const;

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;

export const MIN_USERNAME = 3;
export const MAX_USERNAME = 24;
export const MIN_PASSWORD = 8;

export interface User {
  readonly id: string;
  readonly username: string;
}

export class AuthUnavailable extends Error {
  constructor() {
    super('Accounts need a database; set DATABASE_URL.');
    this.name = 'AuthUnavailable';
  }
}

function requirePool() {
  const pool = getPool();
  if (!pool) throw new AuthUnavailable();
  return pool;
}

/* ------------------------------------------------------------------ hashing */

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;

  const expected = Buffer.from(hash, 'base64url');
  const derived = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  // Constant time: a length check first, since timingSafeEqual throws on a mismatch.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/* ----------------------------------------------------------------- sessions */

interface TokenPayload {
  sub: string;
  name: string;
  exp: number;
}

const sign = (data: string): string =>
  createHmac('sha256', config.sessionSecret).update(data).digest('base64url');

export function issueToken(user: User): string {
  const payload: TokenPayload = {
    sub: user.id,
    name: user.username,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

/** The user a token names, or null if it is forged, malformed or expired. */
export function readToken(token: string | undefined): User | null {
  if (!token) return null;
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;

  // Compare the signature before parsing, so a forged token is never decoded.
  const expected = sign(body);
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as TokenPayload;
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null;
    if (payload.exp * 1000 < Date.now()) return null;
    return { id: payload.sub, username: payload.name };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------- users */

export type RegisterResult =
  | { ok: true; user: User }
  | { ok: false; reason: 'disabled' | 'taken' | 'invalid'; message: string };

export function checkCredentials(username: string, password: string): string | null {
  if (username.length < MIN_USERNAME || username.length > MAX_USERNAME) {
    return `Username must be ${MIN_USERNAME}-${MAX_USERNAME} characters.`;
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
    return 'Username may use letters, numbers, and . _ - only.';
  }
  if (password.length < MIN_PASSWORD) {
    return `Password must be at least ${MIN_PASSWORD} characters.`;
  }
  return null;
}

export async function register(username: string, password: string): Promise<RegisterResult> {
  if (!config.registrationEnabled) {
    return { ok: false, reason: 'disabled', message: 'Registration is closed on this server.' };
  }
  const problem = checkCredentials(username, password);
  if (problem) return { ok: false, reason: 'invalid', message: problem };

  const pool = requirePool();
  const hash = await hashPassword(password);
  try {
    const { rows } = await pool.query<{ id: string; username: string }>(
      `INSERT INTO users (username, username_key, password_hash)
       VALUES ($1, lower($1), $2) RETURNING id, username`,
      [username, hash],
    );
    return { ok: true, user: rows[0]! };
  } catch (error) {
    // 23505 is a unique violation: the username is taken.
    if ((error as { code?: string }).code === '23505') {
      return { ok: false, reason: 'taken', message: 'That username is taken.' };
    }
    throw error;
  }
}

/** Verifies a login. Returns null for both a bad username and a bad password. */
export async function login(username: string, password: string): Promise<User | null> {
  const pool = requirePool();
  const { rows } = await pool.query<{ id: string; username: string; password_hash: string }>(
    'SELECT id, username, password_hash FROM users WHERE username_key = lower($1)',
    [username],
  );

  const row = rows[0];
  if (!row) {
    // Hash anyway, so a missing user does not answer faster than a wrong
    // password and leak which usernames exist.
    await hashPassword(password);
    return null;
  }
  if (!(await verifyPassword(password, row.password_hash))) return null;

  await pool.query('UPDATE users SET last_seen_at = now() WHERE id = $1', [row.id]);
  return { id: row.id, username: row.username };
}

export async function findUser(id: string): Promise<User | null> {
  const pool = requirePool();
  const { rows } = await pool.query<{ id: string; username: string }>(
    'SELECT id, username FROM users WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

/* ------------------------------------------------------------------ profile */

/**
 * What a player has chosen about themselves, as opposed to who they are.
 *
 * Deliberately not carried in the session token. A token is signed and lives
 * for two weeks, so anything inside it is a snapshot: an icon changed today
 * would keep showing yesterday's until the player signed in again. Identity
 * belongs in the token because it cannot change; preferences are read from
 * the database each time they are needed.
 */
export interface Profile extends User {
  /** A card number whose art is the player's badge, or null for their initial. */
  readonly icon: string | null;
}

export async function findProfile(id: string): Promise<Profile | null> {
  const pool = requirePool();
  const { rows } = await pool.query<{ id: string; username: string; icon: string | null }>(
    'SELECT id, username, icon FROM users WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Sets a player's badge, or clears it.
 *
 * The value is a card number and the column references `cards`, so a card
 * that does not exist is refused by the database rather than stored and then
 * drawn as a broken image.
 */
export async function setIcon(id: string, icon: string | null): Promise<boolean> {
  const pool = requirePool();
  try {
    const { rowCount } = await pool.query('UPDATE users SET icon = $2 WHERE id = $1', [id, icon]);
    return rowCount === 1;
  } catch (error) {
    // 23503 is a foreign key violation: no such card.
    if ((error as { code?: string }).code === '23503') return false;
    throw error;
  }
}

export type PasswordChange = { ok: true } | { ok: false; message: string };

/**
 * Changes a password, given the current one.
 *
 * The current password is required even though the caller is already signed
 * in: a session token in someone else's hands should not be enough to lock
 * the owner out of their own account.
 */
export async function changePassword(
  id: string,
  current: string,
  next: string,
): Promise<PasswordChange> {
  if (next.length < MIN_PASSWORD) {
    return { ok: false, message: `Password must be at least ${MIN_PASSWORD} characters.` };
  }

  const pool = requirePool();
  const { rows } = await pool.query<{ password_hash: string }>(
    'SELECT password_hash FROM users WHERE id = $1',
    [id],
  );
  const row = rows[0];
  if (!row) return { ok: false, message: 'That account no longer exists.' };
  if (!(await verifyPassword(current, row.password_hash))) {
    return { ok: false, message: 'That is not your current password.' };
  }

  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
    id,
    await hashPassword(next),
  ]);
  return { ok: true };
}

/* -------------------------------------------------------------- operators */

/**
 * Promotes the accounts named in `ADMIN_USERS`. Run once at boot.
 *
 * Names that do not exist yet are ignored rather than created: an operator
 * signs up like anyone else, and this only grants the flag. Quiet when there
 * is no database, so a server without one still starts.
 */
export async function promoteConfiguredAdmins(): Promise<string[]> {
  if (config.adminUsers.length === 0 || !getPool()) return [];
  const pool = requirePool();
  const { rows } = await pool.query<{ username: string }>(
    `UPDATE users SET is_admin = true
      WHERE username_key = ANY($1::text[]) AND is_admin = false
      RETURNING username`,
    [config.adminUsers],
  );
  return rows.map((row) => row.username);
}

export async function isAdmin(id: string): Promise<boolean> {
  if (!getPool()) return false;
  const pool = requirePool();
  const { rows } = await pool.query<{ is_admin: boolean }>(
    'SELECT is_admin FROM users WHERE id = $1',
    [id],
  );
  return rows[0]?.is_admin === true;
}

export interface AccountSummary {
  readonly id: string;
  readonly username: string;
  readonly isAdmin: boolean;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
}

/** Accounts whose name contains `term`. For an operator finding somebody. */
export async function searchUsers(term: string, limit = 25): Promise<AccountSummary[]> {
  const pool = requirePool();
  const { rows } = await pool.query<{
    id: string;
    username: string;
    is_admin: boolean;
    created_at: Date;
    last_seen_at: Date | null;
  }>(
    `SELECT id, username, is_admin, created_at, last_seen_at FROM users
      WHERE username_key LIKE '%' || lower($1) || '%'
      ORDER BY username_key LIMIT $2`,
    [term, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    isAdmin: row.is_admin,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
  }));
}

/**
 * Sets a password without knowing the old one. Operators only.
 *
 * Deliberately separate from `changePassword` rather than a flag on it: the
 * two have different rules about who may call them, and a single function
 * with a "skip the check" argument is one misplaced `true` away from letting
 * anyone reset anyone.
 */
export async function resetPassword(id: string, next: string): Promise<PasswordChange> {
  if (next.length < MIN_PASSWORD) {
    return { ok: false, message: `Password must be at least ${MIN_PASSWORD} characters.` };
  }
  const pool = requirePool();
  const { rowCount } = await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
    id,
    await hashPassword(next),
  ]);
  if (rowCount !== 1) return { ok: false, message: 'No such account.' };
  return { ok: true };
}
