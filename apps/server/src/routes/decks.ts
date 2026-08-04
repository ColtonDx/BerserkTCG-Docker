import { summariseDeck, type DeckEntry } from '@berserk/engine';
import type { FastifyInstance } from 'fastify';
import { currentUser } from './auth.js';
import { databaseEnabled } from '../db.js';
import {
  DecksUnavailable,
  createDeck,
  deleteDeck,
  getDeck,
  listDecks,
  updateDeck,
} from '../decks.js';

/**
 * Deck endpoints.
 *
 * Ownership comes from the signed-in user when there is one. A request without
 * a token falls back to the `owner` it supplies, which is a claim rather than
 * authentication — that path exists so the builder still works before signing
 * in, and should go once login is required.
 */

interface DeckBody {
  name?: unknown;
  cards?: unknown;
  owner?: unknown;
}

/** Accepts only well-formed entries; anything else is a bad request. */
function readEntries(value: unknown): DeckEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: DeckEntry[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const { cardId, quantity } = item as Record<string, unknown>;
    if (typeof cardId !== 'string' || typeof quantity !== 'number') return null;
    if (!Number.isInteger(quantity) || quantity < 0) return null;
    if (quantity > 0) entries.push({ cardId, quantity });
  }
  return entries;
}

/**
 * Who owns the decks in this request: the signed-in account, and nothing else.
 * A deck belongs to a user, so an unauthenticated request has no owner to
 * mean — there is no claimed id to weigh against the token any more.
 */
const ownerOf = (request: { headers: Record<string, unknown> }): string | null =>
  currentUser(request as never)?.id ?? null;

const NO_ACCOUNT = { error: 'Sign in to manage decks.' };

export function registerDeckRoutes(app: FastifyInstance): void {
  // Report deck legality without saving, so the builder can check a draft.
  app.post<{ Body: DeckBody }>('/api/decks/validate', (request, reply) => {
    const cards = readEntries(request.body?.cards);
    if (!cards) return reply.code(400).send({ error: 'cards must be [{ cardId, quantity }]' });
    return summariseDeck(cards);
  });

  app.get<{ Querystring: { owner?: string } }>('/api/decks', async (request, reply) => {
    const owner = ownerOf(request);
    if (!owner) return reply.code(401).send(NO_ACCOUNT);
    if (!databaseEnabled()) return reply.code(503).send({ error: new DecksUnavailable().message });
    return { decks: await listDecks(owner) };
  });

  app.get<{ Params: { id: string } }>('/api/decks/:id', async (request, reply) => {
    if (!databaseEnabled()) return reply.code(503).send({ error: new DecksUnavailable().message });
    const deck = await getDeck(request.params.id);
    if (!deck) return reply.code(404).send({ error: 'No such deck' });
    return deck;
  });

  app.post<{ Body: DeckBody }>('/api/decks', async (request, reply) => {
    const owner = ownerOf(request);
    const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
    const cards = readEntries(request.body?.cards ?? []);
    if (!owner) return reply.code(401).send(NO_ACCOUNT);
    if (!name) return reply.code(400).send({ error: 'name is required' });
    if (!cards) return reply.code(400).send({ error: 'cards must be [{ cardId, quantity }]' });
    if (!databaseEnabled()) return reply.code(503).send({ error: new DecksUnavailable().message });

    // Saved as-is, legal or not: a deck in progress must survive a reload.
    const deck = await createDeck(owner, name, cards);
    return reply.code(201).send(deck);
  });

  app.put<{ Params: { id: string }; Body: DeckBody }>('/api/decks/:id', async (request, reply) => {
    const owner = ownerOf(request);
    if (!owner) return reply.code(401).send(NO_ACCOUNT);
    if (!databaseEnabled()) return reply.code(503).send({ error: new DecksUnavailable().message });

    const changes: { name?: string; cards?: DeckEntry[] } = {};
    if (typeof request.body?.name === 'string') {
      const name = request.body.name.trim();
      if (!name) return reply.code(400).send({ error: 'name cannot be empty' });
      changes.name = name;
    }
    if (request.body?.cards !== undefined) {
      const cards = readEntries(request.body.cards);
      if (!cards) return reply.code(400).send({ error: 'cards must be [{ cardId, quantity }]' });
      changes.cards = cards;
    }

    const deck = await updateDeck(request.params.id, owner, changes);
    if (!deck) return reply.code(404).send({ error: 'No such deck' });
    return deck;
  });

  app.delete<{ Params: { id: string }; Querystring: { owner?: string } }>(
    '/api/decks/:id',
    async (request, reply) => {
      const owner = ownerOf(request);
      if (!owner) return reply.code(401).send(NO_ACCOUNT);
      if (!databaseEnabled())
        return reply.code(503).send({ error: new DecksUnavailable().message });
      const removed = await deleteDeck(request.params.id, owner);
      if (!removed) return reply.code(404).send({ error: 'No such deck' });
      return reply.code(204).send();
    },
  );
}
