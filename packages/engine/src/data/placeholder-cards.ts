import { parseCost, type CardDefinition } from '../cards.js';
import { asCardDefId, type CardDefId } from '../ids.js';

/**
 * PLACEHOLDER CARDS — invented for development only.
 *
 * These are NOT real Berserk cards. They exist so the server, client, and
 * tests have something to shuffle before the real card data is imported.
 * Their costs, levels and stats are made up and mean nothing.
 *
 * Replace this file with real card data once it is available, and delete these
 * entries rather than leaving them alongside real cards.
 */
export const PLACEHOLDER_CARDS: readonly CardDefinition[] = [
  {
    id: asCardDefId('dev-001'),
    name: 'Placeholder Mercenary',
    kind: 'character',
    color: 'red',
    level: 0,
    cost: parseCost('R'),
    stats: { move: 1, range: 1, power: 1, hp: 2 },
    subtypes: ['mercenary'],
    text: 'Placeholder card for development.',
    set: 'dev',
  },
  {
    id: asCardDefId('dev-002'),
    name: 'Placeholder Scout',
    kind: 'character',
    color: 'green',
    level: 1,
    cost: parseCost('1G'),
    stats: { move: 2, range: 2, power: 1, hp: 2 },
    text: 'Placeholder card for development.',
    set: 'dev',
  },
  {
    id: asCardDefId('dev-003'),
    name: 'Placeholder Guardian',
    kind: 'character',
    color: 'white',
    level: 2,
    cost: parseCost('1WW'),
    stats: { move: 1, range: 1, power: 2, hp: 5 },
    text: 'Placeholder card for development.',
    set: 'dev',
  },
  {
    id: asCardDefId('dev-004'),
    name: 'Placeholder Rite',
    kind: 'effect',
    color: 'black',
    level: 1,
    cost: parseCost('BB'),
    duration: 'normal',
    text: 'Placeholder card for development.',
    set: 'dev',
  },
  {
    id: asCardDefId('dev-005'),
    name: 'Placeholder Banner',
    kind: 'effect',
    color: 'white',
    level: 1,
    cost: parseCost('1W'),
    duration: 'eternal',
    unique: true,
    text: 'Placeholder card for development.',
    set: 'dev',
  },
];

/**
 * A deck of placeholder cards for smoke tests and local play. Mercenaries are
 * exempt from the copy limit, so a legal-sized deck can be built from repeats.
 */
export function placeholderDeck(size = 45): CardDefId[] {
  const mercenary = PLACEHOLDER_CARDS[0];
  if (!mercenary) throw new Error('PLACEHOLDER_CARDS is empty');

  const deck: CardDefId[] = [];
  // Up to 3 copies of each non-mercenary card (Rules.md §2), mercenaries fill
  // the rest.
  for (const card of PLACEHOLDER_CARDS.slice(1)) {
    for (let i = 0; i < 3 && deck.length < size; i++) deck.push(card.id);
  }
  while (deck.length < size) deck.push(mercenary.id);
  return deck.slice(0, size);
}
