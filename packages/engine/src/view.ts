import type { CardInstanceId, MatchId, PlayerId } from './ids.js';
import { legalActions } from './legal.js';
import type { EngineContext } from './rules.js';
import { cityLevel, hpOf, isCharacter, moveOf, powerOf } from './rules.js';
import type {
  BattleState,
  CardInstance,
  City,
  GameAction,
  GameEvent,
  GameState,
  MatchStatus,
  PhaseDef,
  PlayerState,
  QuickWindow,
  TurnState,
  ZoneId,
} from './types.js';

/**
 * Hidden-information redaction.
 *
 * `GameState` contains both players' hands, decks, and face-down Set Cards. It
 * must never leave the server. Clients receive a `PlayerView` produced here,
 * which contains only what that seat is entitled to see — a cheating client
 * cannot reveal what it was never sent.
 *
 * Hidden in Berserk (Rules.md §7, §9):
 *  - decks, from everyone;
 *  - hands, from the opponent;
 *  - Set Cards, from the opponent — you may always check your own;
 *  - face-down City cards, from everyone, so the Royal Capital's position is
 *    not known until a city flips face-up.
 *
 * Any new hidden zone has to be handled here as well, or it leaks the moment
 * it is added.
 */

/**
 * A card the viewer may see in full.
 *
 * Face-up characters carry their numbers *as they stand*, not as printed:
 * a continuous ability on the board or a boost from one that has resolved
 * both move them (Rules.md §13), and the client cannot work either out from
 * the card database. Without this the client draws printed Power while the
 * engine spends the real one, and a damage assignment can never balance.
 */
export type VisibleCard = CardInstance & {
  readonly current?: { readonly power: number; readonly hp: number; readonly move: number };
};

/** A card the viewer knows exists but not the identity of. */
export interface HiddenCard {
  readonly instanceId: CardInstanceId;
  readonly owner: PlayerId;
  readonly controller: PlayerId;
  readonly zone: ZoneId;
  /** Set Cards are visibly *somewhere* — the opponent can see which city. */
  readonly cityIndex?: number;
  readonly locked: boolean;
  readonly hidden: true;
}

export type ViewCard = VisibleCard | HiddenCard;

export const isHidden = (card: ViewCard): card is HiddenCard => 'hidden' in card;

/** A city whose card is still face-down: position known, identity not. */
export interface HiddenCity {
  readonly index: number;
  readonly faceUp: false;
  readonly occupiedBy: PlayerId | null;
  readonly hidden: true;
}

export type ViewCity = City | HiddenCity;

export const isCityHidden = (city: ViewCity): city is HiddenCity => 'hidden' in city;

export interface PlayerView {
  readonly matchId: MatchId;
  readonly version: number;
  readonly status: MatchStatus;
  /** The seat this view was built for. */
  readonly viewer: PlayerId;
  readonly seats: readonly PlayerId[];
  readonly players: Readonly<Record<string, PlayerState>>;
  readonly cities: readonly ViewCity[];
  /** Current City Level, the gate on opening cards. Rules.md §5. */
  readonly cityLevel: number;
  readonly phases: readonly PhaseDef[];
  readonly turn: TurnState;
  /** Cards the viewer can see, plus placeholders for ones they cannot. */
  readonly cards: Readonly<Record<string, ViewCard>>;
  /** Ordering for zones the viewer may see in order (their own hand). */
  readonly zoneOrder: Readonly<Record<string, readonly CardInstanceId[]>>;
  /** Card counts for hidden zones, which the viewer is allowed to know. */
  readonly zoneCounts: Readonly<Record<string, number>>;
  /** Seats still deciding their opening hand. Rules.md §9. */
  readonly mulliganPending: readonly PlayerId[];
  /** How many cards the viewer must still bottom. DesignNotes 5. */
  readonly pendingBottom: number;
  /** Hand size this player must finish setup on — see `GameState.handTarget`. */
  readonly handTarget: number;
  /**
   * The battle in progress. Public in full: every part of it — who leads, who
   * is committed, whose move it is — happens face up on the table, so there is
   * nothing here to redact. Rules.md §11.
   */
  readonly battle: BattleState | null;
  /** Set while somebody is being asked whether to open a Quick. Rules.md §13. */
  readonly quick: QuickWindow | null;
  /** Exactly what this player may do now — the UI renders from this. */
  readonly legalActions: readonly GameAction[];
  /** Recent events, for the log feed and animations. */
  readonly log: readonly GameEvent[];
}

/** How many trailing log entries to ship. Full history lives on the server. */
const LOG_TAIL = 100;

export function viewFor(ctx: EngineContext, state: GameState, viewer: PlayerId): PlayerView {
  const cards: Record<string, ViewCard> = {};
  const zoneCounts: Record<string, number> = {};

  for (const card of Object.values(state.cards)) {
    cards[card.instanceId] = canSee(card, viewer)
      ? withCurrentStats(ctx, state, card)
      : redactCard(card);
  }

  for (const [key, order] of Object.entries(state.zoneOrder)) {
    zoneCounts[key] = order.length;
  }

  return {
    matchId: state.matchId,
    version: state.version,
    status: state.status,
    viewer,
    seats: state.seats,
    players: state.players,
    cities: state.cities.map(redactCity),
    cityLevel: cityLevel(state),
    phases: state.phases,
    turn: state.turn,
    cards,
    zoneOrder: redactZoneOrder(state, viewer),
    zoneCounts,
    mulliganPending: state.mulliganPending,
    pendingBottom: state.pendingBottom[viewer] ?? 0,
    handTarget: state.handTarget[viewer] ?? 0,
    battle: state.battle,
    quick: state.quick,
    legalActions: legalActions(ctx, state, viewer),
    log: state.log.slice(-LOG_TAIL),
  };
}

/**
 * Adds the live numbers to a face-up character.
 *
 * Only face-up characters on the field: a card in hand or a face-down Set
 * Card has no board presence for an aura to reach, and sending numbers for
 * one would be noise at best.
 */
function withCurrentStats(ctx: EngineContext, state: GameState, card: CardInstance): VisibleCard {
  if (card.zone !== 'city' || !card.faceUp || !isCharacter(ctx, card)) return card;
  return {
    ...card,
    current: {
      power: powerOf(ctx, state, card),
      hp: hpOf(ctx, state, card),
      move: moveOf(ctx, state, card),
    },
  };
}

function canSee(card: CardInstance, viewer: PlayerId): boolean {
  switch (card.zone) {
    case 'deck':
      return false;
    case 'trash':
      // Rules.md §15 — all Trash cards are public.
      return true;
    case 'hand':
      return card.controller === viewer;
    case 'city':
      // A Set Card is visible only to its controller. Rules.md §7.
      return card.faceUp || card.controller === viewer;
  }
}

function redactCard(card: CardInstance): HiddenCard {
  const hidden: HiddenCard = {
    instanceId: card.instanceId,
    owner: card.owner,
    controller: card.controller,
    zone: card.zone,
    locked: card.locked,
    hidden: true,
  };
  return card.cityIndex === undefined ? hidden : { ...hidden, cityIndex: card.cityIndex };
}

/**
 * A face-down city hides which city card it is — including whether it is the
 * Royal Capital. Rules.md §9.1.
 */
function redactCity(city: City): ViewCity {
  if (city.faceUp) return city;
  return { index: city.index, faceUp: false, occupiedBy: city.occupiedBy, hidden: true };
}

/**
 * Deck order is the whole secret, so a viewer never receives one. Hands are
 * sent in order only to their owner; everything else is public.
 */
function redactZoneOrder(
  state: GameState,
  viewer: PlayerId,
): Record<string, readonly CardInstanceId[]> {
  const out: Record<string, readonly CardInstanceId[]> = {};

  for (const [key, order] of Object.entries(state.zoneOrder)) {
    const [owner, zone] = key.split(':');
    if (zone === 'deck') continue; // counts only, via `zoneCounts`
    if (zone === 'hand' && owner !== viewer) continue;
    out[key] = order;
  }

  return out;
}

/** Spectators see only public information — no hand is treated as their own. */
export function spectatorView(ctx: EngineContext, state: GameState): PlayerView {
  const view = viewFor(ctx, state, '__spectator__' as PlayerId);
  return { ...view, legalActions: [] };
}
