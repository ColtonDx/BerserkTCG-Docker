import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AuthUnavailable,
  changePassword,
  findProfile,
  isAdmin,
  issueToken,
  login,
  readToken,
  register,
  resetPassword,
  searchUsers,
  setIcon,
  type User,
} from '../auth.js';
import { config } from './../config.js';
import { databaseEnabled } from '../db.js';

/**
 * Login and registration. DesignNotes 1-2.
 *
 * The token goes back in the response body rather than a cookie: the client is
 * a single-page app that already holds per-browser state, and it keeps this
 * free of CSRF concerns. It travels back in an `Authorization: Bearer` header.
 */

interface Credentials {
  username?: unknown;
  password?: unknown;
}

/** The signed-in user, or null. Never throws — callers decide what to require. */
export function currentUser(request: FastifyRequest): User | null {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return readToken(header.slice('Bearer '.length).trim());
}

const readString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export function registerAuthRoutes(app: FastifyInstance): void {
  /** What the client needs to render the sign-in screen. */
  app.get('/api/auth/config', () => ({
    registrationEnabled: config.registrationEnabled,
    accountsAvailable: databaseEnabled(),
  }));

  app.post<{ Body: Credentials }>('/api/auth/register', async (request, reply) => {
    if (!databaseEnabled()) return reply.code(503).send({ error: new AuthUnavailable().message });

    const username = readString(request.body?.username);
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    const result = await register(username, password);

    if (!result.ok) {
      // A closed server is a 403; a taken name is a conflict; anything else is
      // the client's fault.
      const status = result.reason === 'disabled' ? 403 : result.reason === 'taken' ? 409 : 400;
      return reply.code(status).send({ error: result.message });
    }
    return reply.code(201).send({ token: issueToken(result.user), user: result.user });
  });

  app.post<{ Body: Credentials }>('/api/auth/login', async (request, reply) => {
    if (!databaseEnabled()) return reply.code(503).send({ error: new AuthUnavailable().message });

    const username = readString(request.body?.username);
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    if (!username || !password) {
      return reply.code(400).send({ error: 'Username and password are required.' });
    }

    const user = await login(username, password);
    // One message for both a wrong username and a wrong password, so this
    // cannot be used to discover which accounts exist.
    if (!user) return reply.code(401).send({ error: 'Wrong username or password.' });

    return { token: issueToken(user), user };
  });

  /**
   * Confirms a stored token is still good, and returns who it belongs to.
   *
   * The profile comes from the database rather than from the token, so a
   * badge changed since signing in is the one that comes back.
   */
  app.get('/api/auth/me', async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: 'Not signed in.' });
    if (!databaseEnabled()) return { user };

    const profile = await findProfile(user.id);
    // A token whose account has been deleted is no longer a session.
    if (!profile) return reply.code(401).send({ error: 'Not signed in.' });
    // Admin travels with the profile, not in the token: a token lives for two
    // weeks, and a revoked operator should stop being one at once.
    return { user: { ...profile, isAdmin: await isAdmin(user.id) } };
  });

  /** Choose the card whose art is your badge, or clear it. */
  app.patch<{ Body: { icon?: unknown } }>('/api/auth/me', async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: 'Not signed in.' });
    if (!databaseEnabled()) return reply.code(503).send({ error: new AuthUnavailable().message });

    const raw = request.body?.icon;
    // Null clears it; anything else has to be a card number, and the database
    // is what decides whether it names a real card.
    const icon = raw === null ? null : readString(raw);
    if (icon !== null && !icon) return reply.code(400).send({ error: 'Give a card number.' });

    if (!(await setIcon(user.id, icon))) {
      return reply.code(400).send({ error: 'No such card.' });
    }
    return { user: { ...user, icon } };
  });

  /**
   * Change your password. Requires the current one — a stolen session token
   * should not be enough to lock the owner out of their own account.
   *
   * This is a *change*, not a reset: resetting a password nobody remembers
   * needs a channel this server does not have. See TODO.md.
   */
  /**
   * Operator routes. There is no recovery email on this server, so resetting
   * a forgotten password is a person doing it for you — which means these
   * have to be locked to operators and to nobody else.
   */
  const requireAdmin = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<User | null> => {
    const user = currentUser(request);
    if (!user) {
      void reply.code(401).send({ error: 'Not signed in.' });
      return null;
    }
    if (!databaseEnabled()) {
      void reply.code(503).send({ error: new AuthUnavailable().message });
      return null;
    }
    if (!(await isAdmin(user.id))) {
      // The same answer a non-operator gets for a route that does not exist,
      // so this cannot be used to find out who the operators are.
      void reply.code(404).send({ error: 'Not found.' });
      return null;
    }
    return user;
  };

  app.get<{ Querystring: { q?: string } }>('/api/admin/users', async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return reply;
    return { users: await searchUsers(readString(request.query?.q)) };
  });

  app.post<{ Params: { id: string }; Body: { next?: unknown } }>(
    '/api/admin/users/:id/password',
    async (request, reply) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return reply;

      const next = typeof request.body?.next === 'string' ? request.body.next : '';
      if (!next) return reply.code(400).send({ error: 'Give a new password.' });

      const result = await resetPassword(request.params.id, next);
      if (!result.ok) return reply.code(400).send({ error: result.message });
      request.log.info({ admin: admin.username, target: request.params.id }, 'password reset');
      return { ok: true };
    },
  );

  app.post<{ Body: { current?: unknown; next?: unknown } }>(
    '/api/auth/password',
    async (request, reply) => {
      const user = currentUser(request);
      if (!user) return reply.code(401).send({ error: 'Not signed in.' });
      if (!databaseEnabled()) return reply.code(503).send({ error: new AuthUnavailable().message });

      const current = typeof request.body?.current === 'string' ? request.body.current : '';
      const next = typeof request.body?.next === 'string' ? request.body.next : '';
      if (!current || !next) {
        return reply.code(400).send({ error: 'Both passwords are required.' });
      }

      const result = await changePassword(user.id, current, next);
      if (!result.ok) return reply.code(400).send({ error: result.message });
      // A fresh token, so the new password and the session agree from here.
      return { token: issueToken(user), user };
    },
  );
}
