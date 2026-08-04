import { summariseDeck, type DeckEntry, type DeckSummary } from '@berserk/engine';
import { getPool } from './db.js';

/**
 * Deck storage.
 *
 * Decks are saved as they are — including illegal ones, so a half-built deck
 * survives a page reload. Legality is reported alongside rather than enforced
 * on save; it is enforced when a deck is taken into a match.
 *
 * The rules themselves live in `@berserk/engine`, not here. This module only
 * moves rows.
 */

export interface Deck {
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  readonly precon: boolean;
  readonly cards: readonly DeckEntry[];
  readonly summary: DeckSummary;
  readonly updatedAt: string;
}

interface DeckRow {
  id: string;
  owner: string;
  name: string;
  precon: boolean;
  updated_at: Date;
  cards: { cardId: string; quantity: number }[] | null;
}

export class DecksUnavailable extends Error {
  constructor() {
    super('Deck storage needs a database; set DATABASE_URL.');
    this.name = 'DecksUnavailable';
  }
}

function requirePool() {
  const pool = getPool();
  if (!pool) throw new DecksUnavailable();
  return pool;
}

const toDeck = (row: DeckRow): Deck => {
  const cards = (row.cards ?? []).filter((entry) => entry !== null);
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    precon: row.precon,
    cards,
    summary: summariseDeck(cards),
    updatedAt: row.updated_at.toISOString(),
  };
};

// Decks are always read with their cards; one query beats a round trip per deck.
const SELECT_DECKS = `
  SELECT d.id, d.owner, d.name, d.precon, d.updated_at,
         COALESCE(
           json_agg(json_build_object('cardId', dc.card_id, 'quantity', dc.quantity)
                    ORDER BY dc.card_id)
           FILTER (WHERE dc.card_id IS NOT NULL),
           '[]'
         ) AS cards
  FROM decks d
  LEFT JOIN deck_cards dc ON dc.deck_id = d.id
`;

/** Every deck a player can choose from: their own, plus the precons. */
export async function listDecks(owner: string): Promise<Deck[]> {
  const pool = requirePool();
  const { rows } = await pool.query<DeckRow>(
    `${SELECT_DECKS} WHERE d.owner = $1 OR d.precon GROUP BY d.id ORDER BY d.precon, d.updated_at DESC`,
    [owner],
  );
  return rows.map(toDeck);
}

/** The decks that ship with the game, for the AI and for new players. */
export async function listPrecons(): Promise<Deck[]> {
  const pool = requirePool();
  const { rows } = await pool.query<DeckRow>(
    `${SELECT_DECKS} WHERE d.precon GROUP BY d.id ORDER BY d.name`,
  );
  return rows.map(toDeck);
}

export async function getDeck(id: string): Promise<Deck | null> {
  const pool = requirePool();
  const { rows } = await pool.query<DeckRow>(`${SELECT_DECKS} WHERE d.id = $1 GROUP BY d.id`, [id]);
  return rows[0] ? toDeck(rows[0]) : null;
}

export async function createDeck(
  owner: string,
  name: string,
  cards: readonly DeckEntry[],
): Promise<Deck> {
  const pool = requirePool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      'INSERT INTO decks (owner, name) VALUES ($1, $2) RETURNING id',
      [owner, name],
    );
    const id = rows[0]!.id;
    await writeCards(client, id, cards);
    await client.query('COMMIT');
    return (await getDeck(id))!;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Replaces a deck's contents. Returns null if the deck does not exist or
 * belongs to someone else — the caller cannot tell the two apart, which is
 * deliberate.
 */
export async function updateDeck(
  id: string,
  owner: string,
  changes: { name?: string; cards?: readonly DeckEntry[] },
): Promise<Deck | null> {
  const pool = requirePool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `UPDATE decks SET name = COALESCE($3, name), updated_at = now()
       WHERE id = $1 AND owner = $2 AND NOT precon`,
      [id, owner, changes.name ?? null],
    );
    if (!rowCount) {
      await client.query('ROLLBACK');
      return null;
    }
    if (changes.cards) {
      await client.query('DELETE FROM deck_cards WHERE deck_id = $1', [id]);
      await writeCards(client, id, changes.cards);
    }
    await client.query('COMMIT');
    return await getDeck(id);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteDeck(id: string, owner: string): Promise<boolean> {
  const pool = requirePool();
  const { rowCount } = await pool.query(
    'DELETE FROM decks WHERE id = $1 AND owner = $2 AND NOT precon',
    [id, owner],
  );
  return Boolean(rowCount);
}

async function writeCards(
  client: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
  deckId: string,
  cards: readonly DeckEntry[],
): Promise<void> {
  const wanted = cards.filter((entry) => entry.quantity > 0);
  if (wanted.length === 0) return;

  // One multi-row insert; a deck is at most a few dozen distinct cards.
  const values = wanted.map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`).join(', ');
  const params: unknown[] = [deckId];
  for (const entry of wanted) params.push(entry.cardId, entry.quantity);

  await client.query(
    `INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES ${values}
     ON CONFLICT (deck_id, card_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
    params,
  );
}
