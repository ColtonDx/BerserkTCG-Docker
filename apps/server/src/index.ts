import { abilitiesFor, CATALOGUE, catalogueRegistry } from '@berserk/engine';
import { PROTOCOL_VERSION } from '@berserk/protocol';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config, isProduction } from './config.js';
import { closePool, databaseReady } from './db.js';
import { registerGateway } from './gateway.js';
import { promoteConfiguredAdmins } from './auth.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDeckRoutes } from './routes/decks.js';
import { MatchManager } from './matches.js';

/**
 * Game server entry point. Fastify handles HTTP (health, card data, and in
 * production the built client); Socket.IO carries the real-time match traffic.
 */

const app = Fastify({
  logger: isProduction ? true : { transport: { target: 'pino-pretty' } },
});

const matches = new MatchManager();

await app.register(cors, { origin: config.corsOrigins, credentials: true });

app.get('/health', async () => ({
  status: 'ok',
  protocolVersion: PROTOCOL_VERSION,
  matches: matches.size,
  cards: CATALOGUE.length,
  database: config.databaseUrl ? await databaseReady() : 'disabled',
  registration: config.registrationEnabled,
  uptime: process.uptime(),
}));

/**
 * Card definitions as the engine sees them, costs parsed. Cached hard —
 * definitions never change at runtime.
 *
 * This used to serve `PLACEHOLDER_CARDS`, which was invented filler from
 * before the real card data existed. Nothing should ever be built against
 * those again; they survive only as a fixture for the engine's own tests.
 */
app.get('/api/cards', (_req, reply) => {
  void reply.header('cache-control', 'public, max-age=300');
  return { cards: catalogueRegistry().all() };
});

/**
 * The card catalogue: every card that exists, with the path to its image.
 * This is what the deckbuilder lists.
 */
app.get('/api/catalogue', (_req, reply) => {
  void reply.header('cache-control', 'public, max-age=300');
  // `implemented` says whether the engine carries this card's behaviour yet
  // (Rules.md §13). The client shows it so a player can tell a card that does
  // nothing from one whose ability simply is not built — with most of the set
  // still to go, that difference is worth being honest about.
  return {
    cards: CATALOGUE.map((card) => ({
      ...card,
      implemented: abilitiesFor(card.id).length > 0,
    })),
  };
});

// Card art. Immutable — a card image never changes once cut, and the filename
// is the card number, so it can be cached indefinitely.
const cardRoot = config.cardDir ? resolve(config.cardDir) : null;
if (cardRoot && existsSync(cardRoot)) {
  await app.register(fastifyStatic, {
    root: cardRoot,
    prefix: '/cards/',
    decorateReply: false,
    cacheControl: true,
    maxAge: '365d',
    immutable: true,
  });
  app.log.info({ root: cardRoot, cards: CATALOGUE.length }, 'serving card images');
} else if (config.cardDir) {
  app.log.warn({ root: config.cardDir }, 'CARD_DIR does not exist; card art will 404');
}

// Single-container production: serve the built client from this process.
if (config.staticDir) {
  const root = resolve(config.staticDir);
  if (existsSync(root)) {
    await app.register(fastifyStatic, { root });
    // SPA fallback — anything unmatched renders the client shell.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/socket.io')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.log.warn({ root }, 'STATIC_DIR does not exist; not serving the client');
  }
}

registerAuthRoutes(app);
registerDeckRoutes(app);
registerGateway(app, matches);

// Reclaim finished and abandoned matches so memory does not grow unbounded.
const sweeper = setInterval(
  () => {
    const removed = matches.sweep();
    if (removed > 0) app.log.info({ removed }, 'swept inactive matches');
  },
  15 * 60 * 1000,
);
sweeper.unref();

try {
  // Operators named in ADMIN_USERS get the flag before the first request, so
  // a fresh deployment has somebody who can reset a password.
  const promoted = await promoteConfiguredAdmins().catch(() => []);
  if (promoted.length > 0) app.log.info({ promoted }, 'promoted operators');

  await app.listen({ host: config.host, port: config.port });
  app.log.info({ protocolVersion: PROTOCOL_VERSION }, 'berserk server ready');
} catch (error) {
  app.log.error(error, 'failed to start');
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app
      .close()
      .then(closePool)
      .then(() => process.exit(0));
  });
}
