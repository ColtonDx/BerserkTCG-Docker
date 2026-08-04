import { CATALOGUE_BY_ID, type CatalogueCard } from './data/catalogue.js';

/**
 * Deck legality, per `Docs/Deckbuilding.md`:
 *
 *   - a deck is exactly 45 cards;
 *   - no more than 3 copies of any one card;
 *   - at least 10 mercenaries, which are exempt from the copy limit and may be
 *     included in any number.
 *
 * "Mercenary" means the card *named* Mercenary — four per set, one per colour,
 * twenty in all. Cards that merely carry the `Mercenaries` faction, such as
 * `BK1-002 Bold Siege Squadron`, are ordinary cards capped at 3.
 *
 * The copy limit counts by card number, not by name: Rules.md §2 spells it out
 * as "3 copies of any single card (same card number)", so the same card
 * reprinted in a later set is a separate card for deckbuilding.
 */

export const DECK_SIZE = 45;
export const MAX_COPIES = 3;
export const MIN_MERCENARIES = 10;

/** A card and how many copies of it a deck holds. */
export interface DeckEntry {
  readonly cardId: string;
  readonly quantity: number;
}

export type DeckErrorCode =
  'WRONG_SIZE' | 'TOO_MANY_COPIES' | 'TOO_FEW_MERCENARIES' | 'UNKNOWN_CARD' | 'INVALID_QUANTITY';

export interface DeckError {
  readonly code: DeckErrorCode;
  readonly message: string;
  /** The offending card, where one card is at fault. */
  readonly cardId?: string;
}

export interface DeckSummary {
  readonly size: number;
  readonly mercenaries: number;
  readonly legal: boolean;
  readonly errors: readonly DeckError[];
}

const lookup = (cardId: string): CatalogueCard | undefined => CATALOGUE_BY_ID.get(cardId);

export const isMercenary = (cardId: string): boolean => lookup(cardId)?.mercenary ?? false;

/** Total cards in a deck, counting copies. */
export const deckSize = (entries: readonly DeckEntry[]): number =>
  entries.reduce((total, entry) => total + entry.quantity, 0);

/** Mercenaries in a deck, counting copies. Rules.md §2 requires at least ten. */
export const mercenaryCount = (entries: readonly DeckEntry[]): number =>
  entries.reduce((total, entry) => total + (isMercenary(entry.cardId) ? entry.quantity : 0), 0);

/**
 * How many more copies of a card a deck may take. Mercenaries are unlimited,
 * so this returns Infinity for them — the UI uses it to disable "add".
 */
export function copiesRemaining(entries: readonly DeckEntry[], cardId: string): number {
  if (isMercenary(cardId)) return Number.POSITIVE_INFINITY;
  const held = entries.find((entry) => entry.cardId === cardId)?.quantity ?? 0;
  return Math.max(0, MAX_COPIES - held);
}

/** Every way a deck breaks the rules. Empty means legal. */
export function validateDeck(entries: readonly DeckEntry[]): DeckError[] {
  const errors: DeckError[] = [];

  for (const entry of entries) {
    if (!Number.isInteger(entry.quantity) || entry.quantity < 1) {
      errors.push({
        code: 'INVALID_QUANTITY',
        message: `${entry.cardId}: quantity must be a positive whole number.`,
        cardId: entry.cardId,
      });
      continue;
    }
    const card = lookup(entry.cardId);
    if (!card) {
      errors.push({
        code: 'UNKNOWN_CARD',
        message: `${entry.cardId} is not a card.`,
        cardId: entry.cardId,
      });
      continue;
    }
    if (!card.mercenary && entry.quantity > MAX_COPIES) {
      errors.push({
        code: 'TOO_MANY_COPIES',
        message: `${entry.cardId}: ${entry.quantity} copies, limit is ${MAX_COPIES}.`,
        cardId: entry.cardId,
      });
    }
  }

  const size = deckSize(entries);
  if (size !== DECK_SIZE) {
    errors.push({
      code: 'WRONG_SIZE',
      message: `A deck must be exactly ${DECK_SIZE} cards (this one is ${size}).`,
    });
  }

  const mercenaries = mercenaryCount(entries);
  if (mercenaries < MIN_MERCENARIES) {
    errors.push({
      code: 'TOO_FEW_MERCENARIES',
      message: `A deck needs at least ${MIN_MERCENARIES} mercenaries (this one has ${mercenaries}).`,
    });
  }

  return errors;
}

/** Deck size, mercenary count and legality in one pass, for the UI. */
export function summariseDeck(entries: readonly DeckEntry[]): DeckSummary {
  const errors = validateDeck(entries);
  return {
    size: deckSize(entries),
    mercenaries: mercenaryCount(entries),
    legal: errors.length === 0,
    errors,
  };
}

/** Expands a deck into the individual cards a match shuffles. */
export function expandDeck(entries: readonly DeckEntry[]): string[] {
  const cards: string[] = [];
  for (const entry of entries) {
    for (let i = 0; i < entry.quantity; i++) cards.push(entry.cardId);
  }
  return cards;
}

/** Collapses a list of cards back into entries, for saving. */
export function collapseDeck(cards: readonly string[]): DeckEntry[] {
  const counts = new Map<string, number>();
  for (const cardId of cards) counts.set(cardId, (counts.get(cardId) ?? 0) + 1);
  return [...counts].map(([cardId, quantity]) => ({ cardId, quantity }));
}
