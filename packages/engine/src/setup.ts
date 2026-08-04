import type { CardRegistry } from './cards.js';
import { collapseDeck, validateDeck } from './deck.js';
import {
  asCardInstanceId,
  type CardDefId,
  type CardInstanceId,
  type MatchId,
  type PlayerId,
} from './ids.js';
import { createRng, shuffle, type Rng } from './rng.js';
import type { CardInstance, City, GameState, PhaseDef, PlayerState } from './types.js';
import { zoneKey } from './zones.js';

/**
 * Match creation. Everything random here goes through the seeded RNG, so
 * `createMatch` with the same seed and deck lists always produces byte-identical
 * state — the property the whole replay/debug story rests on.
 *
 * Follows Rules.md §9 "Game Setup": shuffle the cities face-down, randomly
 * pick the first player, draw 7, then offer mulligans.
 */

/** The five phases of a turn, in order. Rules.md §10. */
export const DEFAULT_PHASES: readonly PhaseDef[] = [
  { id: 'refresh', name: 'Refresh', autoAdvance: true },
  { id: 'draw', name: 'Draw', autoAdvance: true },
  { id: 'open', name: 'Open', autoAdvance: false },
  { id: 'main', name: 'Main', autoAdvance: false },
  { id: 'end', name: 'End', autoAdvance: true },
];

/** Rules.md §2: five shared City cards, one of which is the Royal Capital. */
export const CITY_COUNT = 5;
export const STARTING_HAND_SIZE = 7;

/** Placeholder city names; the printed cards have their own. */
const DEFAULT_CITY_NAMES: readonly string[] = [
  'Royal Capital',
  'Godot',
  'Wyndham',
  'Enoch',
  'Albion',
];

export interface DeckList {
  readonly playerId: PlayerId;
  readonly name: string;
  /** The card whose art is this player's badge. See `PlayerState.icon`. */
  readonly icon?: string | undefined;
  readonly cards: readonly CardDefId[];
}

export interface MatchConfig {
  readonly matchId: MatchId;
  readonly seed: number;
  readonly registry: CardRegistry;
  readonly decks: readonly [DeckList, DeckList];
  readonly phases?: readonly PhaseDef[];
  /**
   * Enforce the Rules.md §2 deckbuilding limits. Off by default so tests and
   * local play can use small decks; the server should turn it on.
   */
  readonly validateDecks?: boolean;
}

export function createMatch(config: MatchConfig): GameState {
  const { matchId, seed, registry, decks, phases = DEFAULT_PHASES } = config;

  for (const deck of decks) {
    for (const defId of deck.cards) {
      if (!registry.has(defId)) {
        throw new Error(`Deck for ${deck.name} references unknown card: ${defId}`);
      }
    }
    if (config.validateDecks) {
      const errors = validateDeck(collapseDeck(deck.cards));
      if (errors.length > 0) {
        throw new Error(`Illegal deck for ${deck.name}: ${errors.map((e) => e.message).join(' ')}`);
      }
    }
  }

  let rng = createRng(seed);

  // Rules.md §9.2 — the first player is determined randomly, not by join order.
  const seatShuffle = shuffle(
    decks.map((deck) => deck.playerId),
    rng,
  );
  rng = seatShuffle.rng;
  const seats = seatShuffle.items;

  const cityShuffle = shuffle(DEFAULT_CITY_NAMES.slice(0, CITY_COUNT), rng);
  rng = cityShuffle.rng;
  // Rules.md §9.1 — cities start face-down, so all cities are City Lv. 0.
  const cities: City[] = cityShuffle.items.map((name, index) => ({
    index,
    name,
    royalCapital: name === 'Royal Capital',
    faceUp: false,
    occupiedBy: null,
  }));

  const players: Record<string, PlayerState> = {};
  const cards: Record<string, CardInstance> = {};
  const zoneOrder: Record<string, CardInstanceId[]> = {};
  let instanceCounter = 0;

  for (const deck of decks) {
    players[deck.playerId] = {
      id: deck.playerId,
      name: deck.name,
      eliminated: false,
      connected: true,
      ...(deck.icon ? { icon: deck.icon } : {}),
    };

    const instances = deck.cards.map((defId) => {
      const instanceId = asCardInstanceId(`c${++instanceCounter}`);
      cards[instanceId] = {
        instanceId,
        defId,
        owner: deck.playerId,
        controller: deck.playerId,
        zone: 'deck',
        faceUp: false,
        locked: false,
        damage: 0,
        counters: {},
      };
      return instanceId;
    });

    const shuffled = shuffle(instances, rng);
    rng = shuffled.rng;

    zoneOrder[zoneKey(deck.playerId, 'deck')] = shuffled.items;
    zoneOrder[zoneKey(deck.playerId, 'hand')] = [];
    zoneOrder[zoneKey(deck.playerId, 'trash')] = [];
  }

  const firstPlayer = seats[0] as PlayerId;

  let state: GameState = {
    matchId,
    version: 0,
    // Rules.md §9.4 — mulligans happen before the first turn begins.
    status: { kind: 'setup' },
    seats,
    players,
    cities,
    cards,
    zoneOrder,
    phases,
    turn: {
      activePlayer: firstPlayer,
      priorityPlayer: firstPlayer,
      phaseIndex: 0,
      turnNumber: 1,
      openedThisTurn: false,
      battledCities: [],
    },
    mulliganPending: seats,
    pendingBottom: {},
    handTarget: Object.fromEntries(seats.map((seat) => [seat, STARTING_HAND_SIZE])),
    battle: null,
    quick: null,
    rng,
    log: [{ type: 'MATCH_STARTED', firstPlayer }],
  };

  for (const seat of seats) {
    state = drawCards(state, seat, STARTING_HAND_SIZE);
  }

  return state;
}

/**
 * Draws from the top of a player's deck.
 *
 * Deck-out is *not* handled here. Rules.md §1 makes it a loss only when a
 * player is *required* to draw from an empty deck, so the caller decides —
 * see the Draw phase in `reducer.ts`.
 */
export function drawCards(state: GameState, player: PlayerId, count: number): GameState {
  const deckKey = zoneKey(player, 'deck');
  const handKey = zoneKey(player, 'hand');
  const deck = [...(state.zoneOrder[deckKey] ?? [])];
  const hand = [...(state.zoneOrder[handKey] ?? [])];
  const cards = { ...state.cards };
  const log = [...state.log];

  const drawn = deck.splice(0, Math.min(count, deck.length));
  for (const id of drawn) {
    const card = cards[id];
    if (!card) throw new Error(`Deck references unknown card: ${id}`);
    cards[id] = { ...card, zone: 'hand' };
    hand.push(id);
    log.push({ type: 'CARD_DRAWN', player, card: id });
  }

  return {
    ...state,
    cards,
    zoneOrder: { ...state.zoneOrder, [deckKey]: deck, [handKey]: hand },
    log,
  };
}

/** A player must always keep at least one card. DesignNotes 5. */
export const MIN_KEPT_HAND = 1;

/**
 * Mulligan: shuffle the hand back and redraw a full opening hand, lowering by
 * one the size this player must finish on. Rules.md §9.4 and DesignNotes 5.
 *
 * Nothing is bottomed here. A player decides whether to keep a hand before
 * paying for it — being made to discard down and only then choose whether to
 * mulligan again would have them pay for a hand they are about to throw away.
 */
export function mulligan(state: GameState, player: PlayerId): GameState {
  const deckKey = zoneKey(player, 'deck');
  const handKey = zoneKey(player, 'hand');
  const hand = state.zoneOrder[handKey] ?? [];

  const targetSize = Math.max(MIN_KEPT_HAND, (state.handTarget[player] ?? STARTING_HAND_SIZE) - 1);

  const cards = { ...state.cards };
  for (const id of hand) {
    const card = cards[id];
    if (card) cards[id] = { ...card, zone: 'deck' };
  }

  const combined = [...(state.zoneOrder[deckKey] ?? []), ...hand];
  const shuffled: { items: CardInstanceId[]; rng: Rng } = shuffle(combined, state.rng);

  const reshuffled: GameState = {
    ...state,
    cards,
    zoneOrder: { ...state.zoneOrder, [deckKey]: shuffled.items, [handKey]: [] },
    rng: shuffled.rng,
    log: [...state.log, { type: 'MULLIGANED', player, handSize: targetSize }],
  };

  const drawn = drawCards(reshuffled, player, STARTING_HAND_SIZE);
  return {
    ...drawn,
    handTarget: { ...drawn.handTarget, [player]: targetSize },
  };
}

/** Puts one card from hand on the bottom of its owner's deck. DesignNotes 5. */
export function bottomCard(state: GameState, player: PlayerId, cardId: CardInstanceId): GameState {
  const deckKey = zoneKey(player, 'deck');
  const handKey = zoneKey(player, 'hand');
  const hand = (state.zoneOrder[handKey] ?? []).filter((id) => id !== cardId);
  const card = state.cards[cardId];
  if (!card) throw new Error(`Cannot bottom unknown card: ${cardId}`);

  const remaining = Math.max(0, (state.pendingBottom[player] ?? 0) - 1);

  return {
    ...state,
    cards: { ...state.cards, [cardId]: { ...card, zone: 'deck' } },
    zoneOrder: {
      ...state.zoneOrder,
      [handKey]: hand,
      [deckKey]: [...(state.zoneOrder[deckKey] ?? []), cardId],
    },
    pendingBottom: { ...state.pendingBottom, [player]: remaining },
    log: [...state.log, { type: 'CARD_BOTTOMED', player, card: cardId }],
  };
}
