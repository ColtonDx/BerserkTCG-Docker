import {
  asCardDefId,
  asMatchId,
  asPlayerId,
  summariseDeck,
  type CardDefId,
  type DeckEntry,
  type Engine,
  type PlayerId,
} from '@berserk/engine';

/**
 * The guided game. DesignNotes "Tutorial".
 *
 * A tutorial is an ordinary match against Femto with two things fixed: the
 * decks, and the seed. The engine is deterministic from those (`rng.ts`), so
 * the first player, the cities and both opening hands are the same every
 * time — which is what lets the client's coach know that the player goes
 * first, holds Mercenaries to set, and will draw into a Quick. Nothing about
 * the rules changes; the coach only explains what the table is asking.
 *
 * The seed is not hard-coded. It is *found*: the first seed from 1 upward
 * whose deal puts the human in the first seat with a hand worth teaching
 * from. That survives a change to the deck lists or the shuffle, and a test
 * pins that a seed exists.
 */

/**
 * A white deck built to show the game's moves in order. Sixteen Mercenaries
 * (Level 0, so they open under any City Level) to claim areas with; Level 1
 * bodies to open once a city is awake; a Quick draw and two Quick buffs so a
 * window opens; and two characters whose abilities are built.
 */
const TUTORIAL_LIST: readonly DeckEntry[] = [
  { cardId: 'BK1-001', quantity: 16 }, // Mercenary
  { cardId: 'BK1-002', quantity: 3 }, // Bold Siege Squadron
  { cardId: 'BK1-003', quantity: 2 }, // Moonlight Raiders
  { cardId: 'BK1-004', quantity: 3 }, // Urgent Dispatch Rider — targets on open
  { cardId: 'BK1-012', quantity: 3 }, // Guts — Level 2
  { cardId: 'BK1-013', quantity: 3 }, // Casca — a Quick "Tap:" ability
  { cardId: 'BK1-017', quantity: 3 }, // Corkus — opponent discards
  { cardId: 'BK1-018', quantity: 3 }, // Corkus — draws while occupying
  { cardId: 'BK1-024', quantity: 3 }, // Foolish Banditry — Quick draw
  { cardId: 'BK1-026', quantity: 3 }, // Negotiate By Force — Quick +1/+1
  { cardId: 'BK1-040', quantity: 3 }, // Spring Into Battle — Quick +2/+2
];

export const TUTORIAL_DECK = {
  id: 'tutorial',
  name: 'Band of the Hawk (tutorial)',
  cards: TUTORIAL_LIST,
} as const;

/** The list as the engine deals it: one entry per physical card. */
export const tutorialCards = (): CardDefId[] =>
  TUTORIAL_LIST.flatMap((entry) => Array.from({ length: entry.quantity }, () => entry.cardId)).map(
    asCardDefId,
  );

/** A hand worth teaching from: something to set now, something to open later. */
function teachable(defIds: readonly string[]): boolean {
  const mercenaries = defIds.filter((id) => id === 'BK1-001').length;
  const levelOnes = defIds.filter((id) =>
    ['BK1-002', 'BK1-003', 'BK1-004', 'BK1-013', 'BK1-017', 'BK1-018'].includes(id),
  ).length;
  return mercenaries >= 2 && mercenaries <= 4 && levelOnes >= 1;
}

const found = new Map<string, number>();

/**
 * The seed the tutorial deals from, for this pair of seats.
 *
 * Searched rather than stored: the first seed whose deal seats the human
 * first (Rules.md §9.2 is a coin toss, and a tutorial cannot open with
 * "Femto goes first, watch") with a hand that has Mercenaries to set and a
 * Level 1 to open. Cached per human seat, since the seat id is part of what
 * the shuffle orders.
 */
export function tutorialSeed(engine: Engine, human: PlayerId, ai: PlayerId): number {
  const key = `${human}|${ai}`;
  const cached = found.get(key);
  if (cached !== undefined) return cached;

  const cards = tutorialCards();
  for (let seed = 1; seed < 20_000; seed++) {
    const state = engine.createMatch({
      matchId: asMatchId('tutorial'),
      seed,
      decks: [
        { playerId: human, name: 'You', cards },
        { playerId: ai, name: 'Femto', cards },
      ],
    });
    if (state.seats[0] !== human) continue;
    const hand = (state.zoneOrder[`${human}:hand`] ?? [])
      .map((id) => state.cards[id]?.defId)
      .filter((id): id is CardDefId => id !== undefined);
    if (!teachable(hand)) continue;
    found.set(key, seed);
    return seed;
  }
  throw new Error('No tutorial seed deals a teachable hand');
}

/** Sanity: the list is a legal deck. Read by the test and at seating. */
export const tutorialDeckLegal = (): boolean => summariseDeck(TUTORIAL_LIST).legal;

/** The seat ids are branded; this is only so the test can name a human. */
export const asTutorialPlayer = (id: string): PlayerId => asPlayerId(id);
