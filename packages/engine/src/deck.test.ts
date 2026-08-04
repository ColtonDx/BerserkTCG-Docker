import { describe, expect, it } from 'vitest';
import { MERCENARIES, cardsInSet } from './data/catalogue.js';
import {
  DECK_SIZE,
  MAX_COPIES,
  MIN_MERCENARIES,
  collapseDeck,
  copiesRemaining,
  deckSize,
  expandDeck,
  isMercenary,
  mercenaryCount,
  summariseDeck,
  validateDeck,
  type DeckEntry,
} from './deck.js';

const MERC = MERCENARIES[0]!.id; // BK1-001
const MERC2 = MERCENARIES[1]!.id;
/** Ordinary BK1 cards, i.e. not the Mercenary at the head of each colour block. */
const ordinary = cardsInSet('BK1')
  .filter((card) => !card.mercenary)
  .map((card) => card.id);

/** `count` ordinary cards, never more than three copies of any one. */
function fill(count: number): string[] {
  const cards: string[] = [];
  for (const cardId of ordinary) {
    for (let i = 0; i < MAX_COPIES && cards.length < count; i++) cards.push(cardId);
    if (cards.length === count) break;
  }
  return cards;
}

/** A legal deck: 10 mercenaries plus 35 ordinary cards, 3 copies at a time. */
function legalDeck(): DeckEntry[] {
  const entries: DeckEntry[] = [{ cardId: MERC, quantity: MIN_MERCENARIES }];
  let remaining = DECK_SIZE - MIN_MERCENARIES;
  for (const cardId of ordinary) {
    if (remaining === 0) break;
    const quantity = Math.min(MAX_COPIES, remaining);
    entries.push({ cardId, quantity });
    remaining -= quantity;
  }
  return entries;
}

describe('deck rules (Docs/Deckbuilding.md)', () => {
  it('accepts a legal deck', () => {
    const deck = legalDeck();
    expect(deckSize(deck)).toBe(DECK_SIZE);
    expect(mercenaryCount(deck)).toBe(MIN_MERCENARIES);
    expect(validateDeck(deck)).toEqual([]);
    expect(summariseDeck(deck).legal).toBe(true);
  });

  it('requires exactly 45 cards', () => {
    const short = legalDeck().slice(0, -1);
    expect(validateDeck(short).map((e) => e.code)).toContain('WRONG_SIZE');

    const long = [...legalDeck(), { cardId: ordinary.at(-1)!, quantity: 1 }];
    expect(validateDeck(long).map((e) => e.code)).toContain('WRONG_SIZE');
  });

  it('caps ordinary cards at three copies', () => {
    const deck: DeckEntry[] = [
      { cardId: MERC, quantity: 10 },
      { cardId: ordinary[0]!, quantity: 4 },
      { cardId: ordinary[1]!, quantity: 31 },
    ];
    const errors = validateDeck(deck);
    expect(errors.map((e) => e.code)).toContain('TOO_MANY_COPIES');
    expect(errors.find((e) => e.code === 'TOO_MANY_COPIES')?.cardId).toBe(ordinary[0]);
  });

  it('lets mercenaries exceed the copy limit', () => {
    // "A deck can have any number of mercenary cards."
    const deck: DeckEntry[] = [{ cardId: MERC, quantity: DECK_SIZE }];
    expect(validateDeck(deck)).toEqual([]);
    expect(copiesRemaining(deck, MERC)).toBe(Number.POSITIVE_INFINITY);
  });

  it('requires at least ten mercenaries', () => {
    const deck: DeckEntry[] = [{ cardId: MERC, quantity: 9 }, ...collapseDeck(fill(36))];
    expect(deckSize(deck)).toBe(45);
    expect(validateDeck(deck).map((e) => e.code)).toEqual(['TOO_FEW_MERCENARIES']);
  });

  it('counts mercenaries across sets and colours', () => {
    const deck: DeckEntry[] = [
      { cardId: MERC, quantity: 5 },
      { cardId: MERC2, quantity: 5 },
      ...collapseDeck(fill(35)),
    ];
    expect(mercenaryCount(deck)).toBe(10);
    expect(deckSize(deck)).toBe(45);
    expect(validateDeck(deck)).toEqual([]);
  });

  it('counts copies by card number, so reprints are separate cards', () => {
    // Rules.md §2: "3 copies of any single card (same card number)".
    const deck: DeckEntry[] = [
      { cardId: MERC, quantity: 10 },
      { cardId: 'BK2-002', quantity: 3 },
      { cardId: 'BK3-002', quantity: 3 },
      ...collapseDeck(fill(29)),
    ];
    expect(deckSize(deck)).toBe(45);
    expect(validateDeck(deck)).toEqual([]);
  });

  it('rejects cards that do not exist', () => {
    const deck: DeckEntry[] = [{ cardId: 'BK9-999', quantity: 45 }];
    expect(validateDeck(deck).map((e) => e.code)).toContain('UNKNOWN_CARD');
  });

  it('rejects nonsense quantities', () => {
    expect(validateDeck([{ cardId: MERC, quantity: 0 }]).map((e) => e.code)).toContain(
      'INVALID_QUANTITY',
    );
    expect(validateDeck([{ cardId: MERC, quantity: -3 }]).map((e) => e.code)).toContain(
      'INVALID_QUANTITY',
    );
    expect(validateDeck([{ cardId: MERC, quantity: 1.5 }]).map((e) => e.code)).toContain(
      'INVALID_QUANTITY',
    );
  });

  it('knows which cards are mercenaries', () => {
    expect(isMercenary('BK1-001')).toBe(true);
    // Carries the Mercenaries faction but is not the card named "Mercenary".
    expect(isMercenary('BK1-002')).toBe(false);
    expect(MERCENARIES).toHaveLength(20);
  });

  it('tracks how many more copies a card may take', () => {
    const deck: DeckEntry[] = [{ cardId: ordinary[0]!, quantity: 2 }];
    expect(copiesRemaining(deck, ordinary[0]!)).toBe(1);
    expect(copiesRemaining(deck, ordinary[1]!)).toBe(MAX_COPIES);
  });

  it('round-trips between entries and a shuffled card list', () => {
    const deck = legalDeck();
    const cards = expandDeck(deck);
    expect(cards).toHaveLength(DECK_SIZE);

    const collapsed = collapseDeck(cards);
    expect(deckSize(collapsed)).toBe(DECK_SIZE);
    for (const entry of deck) {
      expect(collapsed.find((e) => e.cardId === entry.cardId)?.quantity).toBe(entry.quantity);
    }
  });

  it('reports size, mercenaries and every problem at once', () => {
    const summary = summariseDeck([
      { cardId: ordinary[0]!, quantity: 4 },
      { cardId: ordinary[1]!, quantity: 2 },
    ]);
    expect(summary.size).toBe(6);
    expect(summary.mercenaries).toBe(0);
    expect(summary.legal).toBe(false);
    expect(summary.errors.map((e) => e.code).sort()).toEqual([
      'TOO_FEW_MERCENARIES',
      'TOO_MANY_COPIES',
      'WRONG_SIZE',
    ]);
  });
});
