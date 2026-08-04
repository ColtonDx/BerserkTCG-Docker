import type { Draft } from './draft.js';
import type { CardInstanceId, PlayerId } from './ids.js';
import type { CardInstance, GameState, PlayerZoneId } from './types.js';

/**
 * Zone and board helpers.
 *
 * Deck/hand/trash membership is stored twice on purpose: `card.zone` for O(1)
 * lookups, `zoneOrder` for ordering (deck top, hand arrangement). Both must
 * stay in sync — always move cards with `moveToZone`/`moveToCity`, never by
 * editing one side by hand.
 *
 * City contents are unordered, so they are derived from `cards` rather than
 * tracked separately.
 */

export const zoneKey = (player: PlayerId, zone: PlayerZoneId): string => `${player}:${zone}`;

export function cardsInZone(
  state: GameState,
  player: PlayerId,
  zone: PlayerZoneId,
): CardInstance[] {
  const order = state.zoneOrder[zoneKey(player, zone)] ?? [];
  return order.map((id) => {
    const card = state.cards[id];
    if (!card) throw new Error(`zoneOrder references unknown card: ${id}`);
    return card;
  });
}

export function zoneSize(state: GameState, player: PlayerId, zone: PlayerZoneId): number {
  return (state.zoneOrder[zoneKey(player, zone)] ?? []).length;
}

export function getCard(state: GameState, id: CardInstanceId): CardInstance | undefined {
  return state.cards[id];
}

/** Every card sitting in a city, optionally filtered to one controller. */
export function cardsInCity(
  state: Pick<GameState, 'cards'>,
  cityIndex: number,
  controller?: PlayerId,
): CardInstance[] {
  return Object.values(state.cards).filter(
    (card) =>
      card.zone === 'city' &&
      card.cityIndex === cityIndex &&
      (controller === undefined || card.controller === controller),
  );
}

/** Face-up characters in a city — what determines presence and city flipping. */
export function charactersInCity(
  state: Pick<GameState, 'cards'>,
  cityIndex: number,
  isCharacter: (card: CardInstance) => boolean,
  controller?: PlayerId,
): CardInstance[] {
  return cardsInCity(state, cityIndex, controller).filter(
    (card) => card.faceUp && isCharacter(card),
  );
}

/**
 * City-to-city distance along the row. Rules.md §15 "Distance": distance 1 is
 * an adjacent city.
 */
export const cityDistance = (from: number, to: number): number => Math.abs(from - to);

/* --------------------------------------------------------------- mutations */

/** Removes a card from whichever ordered zone currently holds it. */
function detach(draft: Draft<GameState>, cardId: CardInstanceId): void {
  for (const order of Object.values(draft.zoneOrder)) {
    const index = order.indexOf(cardId);
    if (index !== -1) {
      order.splice(index, 1);
      return;
    }
  }
}

/**
 * Moves a card into an ordered zone (deck/hand/trash), clearing its board
 * state. `index` defaults to the bottom; pass 0 for the top of a deck.
 */
export function moveToZone(
  draft: Draft<GameState>,
  cardId: CardInstanceId,
  to: { player: PlayerId; zone: PlayerZoneId; index?: number },
): void {
  const card = draft.cards[cardId];
  if (!card) throw new Error(`Cannot move unknown card: ${cardId}`);

  detach(draft, cardId);

  const key = zoneKey(to.player, to.zone);
  const order = (draft.zoneOrder[key] ??= []);
  order.splice(to.index ?? order.length, 0, cardId);

  card.zone = to.zone;
  card.controller = to.player;
  // Leaving the field clears all board state.
  delete card.cityIndex;
  card.faceUp = false;
  card.locked = false;
  card.damage = 0;
}

/** Places a card into a city. `faceUp: false` makes it a Set Card. */
export function moveToCity(
  draft: Draft<GameState>,
  cardId: CardInstanceId,
  cityIndex: number,
  options: { controller: PlayerId; faceUp: boolean },
): void {
  const card = draft.cards[cardId];
  if (!card) throw new Error(`Cannot move unknown card: ${cardId}`);

  detach(draft, cardId);
  card.zone = 'city';
  card.cityIndex = cityIndex;
  card.controller = options.controller;
  card.faceUp = options.faceUp;
}
