import { costTotal } from './cards.js';
import type { CardInstanceId, PlayerId } from './ids.js';
import { currentPhase } from './reducer.js';
import {
  canCommit,
  canVanguard,
  legalTargets,
  moveOf,
  powerOf,
  targetingAbilities,
  cityLevel,
  definitionOf,
  isCharacter,
  uniqueConflict,
  validatePayment,
  HAND_LIMIT,
  type EngineContext,
} from './rules.js';
import { MIN_KEPT_HAND } from './setup.js';
import type { BattleState, CardInstance, GameAction, GameState } from './types.js';
import { cardsInZone, cityDistance } from './zones.js';

/**
 * Every action a player could legally take right now.
 *
 * This is what makes the game feel like a video game rather than a digital
 * tabletop: the client renders only these, so a player can never attempt an
 * illegal move, and the rules never have to be explained through an error
 * message. It is also the action space an AI opponent would sample from.
 *
 * `legalActions` and `reduce` must agree — anything listed here has to be
 * accepted by the reducer, and anything omitted has to be rejected. The
 * property test in `engine.test.ts` enforces that; keep it passing.
 */
export function legalActions(ctx: EngineContext, state: GameState, player: PlayerId): GameAction[] {
  if (state.status.kind === 'finished') return [];
  if (!state.players[player]) return [];

  // Conceding is legal at any time, even without priority.
  const actions: GameAction[] = [{ type: 'CONCEDE' }];

  if (state.status.kind === 'setup') {
    actions.push(...setupActions(state, player));
    return actions;
  }

  // A Quick window takes over everything, including a battle: it is an
  // interrupt, and until it is answered nothing else may happen. Rules.md §13.
  if (state.quick) {
    if (state.quick.waitingOn !== player) return actions;
    actions.push(...quickOpens(ctx, state, player), { type: 'PASS_PRIORITY' });
    return actions;
  }

  // A battle takes over: it has its own steps, and the player it is waiting on
  // is not always the one whose turn it is — the defender acts on the
  // attacker's turn. Rules.md §11.
  if (state.battle) {
    actions.push(...battleActions(ctx, state, state.battle, player));
    return actions;
  }

  if (state.turn.priorityPlayer !== player) return actions;

  const hand = cardsInZone(state, player, 'hand');

  switch (currentPhase(state).id) {
    case 'open':
      actions.push(...openActions(ctx, state, player, hand));
      actions.push({ type: 'END_PHASE' });
      break;

    case 'main':
      actions.push(...setActions(state, hand));
      actions.push(...moveActions(ctx, state, player));
      actions.push(...battleDeclarations(ctx, state, player));
      actions.push({ type: 'END_PHASE' });
      break;

    case 'end':
      if (hand.length > HAND_LIMIT) {
        // Rules.md §10 ⑤ — the turn cannot pass while over the hand limit.
        actions.push(...hand.map((card) => discard(card.instanceId)));
      } else {
        actions.push({ type: 'END_PHASE' });
      }
      break;

    default:
      // Refresh and Draw resolve automatically and are never rested on.
      actions.push({ type: 'END_PHASE' });
      break;
  }

  return actions;
}

const discard = (card: CardInstanceId): GameAction => ({ type: 'DISCARD_CARD', card });

/**
 * Cities that can be attacked. Rules.md §10 ④(4) — one you do not occupy,
 * once per city per turn, and only if you have someone there able to lead.
 */
function battleDeclarations(ctx: EngineContext, state: GameState, player: PlayerId): GameAction[] {
  return state.cities
    .filter(
      (city) =>
        city.occupiedBy !== player &&
        !state.turn.battledCities.includes(city.index) &&
        canVanguard(ctx, state, player, city.index).length > 0,
    )
    .map((city) => ({ type: 'DECLARE_BATTLE', city: city.index }));
}

/**
 * What the battle is waiting for. Rules.md §11.
 *
 * Only ever offered to the seat the step is waiting on, which is why the
 * defender gets actions during the attacker's turn.
 */
/**
 * The Quick Set Cards this player could open right now. Rules.md §13.
 *
 * Quick changes *when* a card may be opened, not what it costs or where it
 * comes from: it still has to be set, still has to be within City Level, and
 * still has to be paid for out of hand (§7). So this is the ordinary open
 * with the phase and the one-a-turn limit lifted, narrowed to Quick cards.
 */
export function quickOpens(ctx: EngineContext, state: GameState, player: PlayerId): GameAction[] {
  const hand = cardsInZone(state, player, 'hand');
  return openActions(ctx, state, player, hand, { ignoreTurnLimit: true, quickOnly: true });
}

function battleActions(
  ctx: EngineContext,
  state: GameState,
  battle: BattleState,
  player: PlayerId,
): GameAction[] {
  if (battle.waitingOn !== player) return [];
  const actions: GameAction[] = [];

  switch (battle.step) {
    case 'vanguard':
      actions.push(
        ...canVanguard(ctx, state, player, battle.city).map((card): GameAction => ({
          type: 'DESIGNATE_VANGUARD',
          card: card.instanceId,
        })),
      );
      // §11 ① — declining ends the battle before anything is spent.
      actions.push({ type: 'BATTLE_PASS' });
      break;

    case 'opens': {
      // §11 ② — one optional open each, in the contested city only.
      const hand = cardsInZone(state, player, 'hand');
      actions.push(
        ...openActions(ctx, state, player, hand, { city: battle.city, ignoreTurnLimit: true }),
      );
      actions.push({ type: 'BATTLE_PASS' });
      break;
    }

    case 'commit':
      actions.push(
        ...canCommit(ctx, state, battle, player).map((card): GameAction => ({
          type: 'COMMIT_CHARACTER',
          card: card.instanceId,
        })),
      );
      actions.push({ type: 'BATTLE_PASS' });
      break;

    case 'damage': {
      // §11 ④ — the striker assigns all of its Power among enemy
      // participants. Offering every possible split would be thousands of
      // actions, so one legal split is offered the way a payment is for an
      // open: the reducer accepts any valid alternative the player sends.
      const striker = battle.assigning[0];
      const suggestion = striker ? suggestAssignment(ctx, state, battle, striker) : null;
      if (striker && suggestion) {
        actions.push({ type: 'ASSIGN_DAMAGE', card: striker, hits: suggestion });
      }
      break;
    }
  }

  return actions;
}

/** Mulligan decisions before the first turn. Rules.md §9, DesignNotes 5. */
function setupActions(state: GameState, player: PlayerId): GameAction[] {
  if (!state.mulliganPending.includes(player)) return [];

  const owed = state.pendingBottom[player] ?? 0;
  const hand = state.zoneOrder[`${player}:hand`] ?? [];

  if (owed > 0) {
    return hand.map((card) => ({ type: 'BOTTOM_CARD', card }));
  }

  const actions: GameAction[] = [{ type: 'KEEP_HAND' }];
  if ((state.handTarget[player] ?? 0) > MIN_KEPT_HAND) actions.push({ type: 'MULLIGAN' });
  return actions;
}

/**
 * One legal way to spend a striker's Power. Rules.md §11 ④.
 *
 * Concentrated on a single enemy rather than spread, because that is the
 * assignment most likely to destroy something, and because a suggestion the
 * player will usually change should at least be decisive.
 */
function suggestAssignment(
  ctx: EngineContext,
  state: GameState,
  battle: BattleState,
  striker: CardInstanceId,
): { target: CardInstanceId; amount: number }[] | null {
  const card = state.cards[striker];
  if (!card) return null;
  const power = powerOf(ctx, state, card);
  if (power <= 0) return [];

  const target = battle.participants
    .map((id) => state.cards[id])
    .find((enemy) => enemy && enemy.zone === 'city' && enemy.controller !== card.controller);
  return target ? [{ target: target.instanceId, amount: power }] : null;
}

/**
 * Opens the player can actually afford. DesignNotes 9: if a player cannot pay
 * the cost they may not even attempt the flip, so unaffordable opens are never
 * offered.
 */
function openActions(
  ctx: EngineContext,
  state: GameState,
  player: PlayerId,
  hand: readonly CardInstance[],
  // The combat open (§11 ②) is the same open under different conditions:
  // confined to the contested city, and outside the turn's one-open limit.
  scope: { city?: number; ignoreTurnLimit?: boolean; quickOnly?: boolean } = {},
): GameAction[] {
  if (state.turn.openedThisTurn && !scope.ignoreTurnLimit) return [];

  const actions: GameAction[] = [];
  const setCards = Object.values(state.cards).filter(
    (card) =>
      card.zone === 'city' &&
      !card.faceUp &&
      card.controller === player &&
      (scope.city === undefined || card.cityIndex === scope.city),
  );

  for (const card of setCards) {
    const def = definitionOf(ctx, card);
    if (scope.quickOnly && !def.quick) continue;
    // Cards whose printed level or cost is not yet captured cannot be opened,
    // so they are never offered. Docs/CardData.md.
    if (def.level === null || def.cost === null) continue;
    if (def.level > cityLevel(state)) continue;
    if (uniqueConflict(ctx, state, def)) continue;

    const payment = choosePayment(ctx, def.cost, hand);
    if (!payment) continue;

    // A suggested target for each ability that asks for one, the way `pay`
    // suggests a payment: legal as offered, and replaceable by any other
    // legal choice. An ability with nobody to point at is offered nothing
    // and simply finds nobody when it resolves.
    const targets = targetingAbilities(ctx, card, 'open')
      .map((ability) => legalTargets(ctx, state, card, ability.target)[0])
      .filter((choice): choice is CardInstance => choice !== undefined)
      .map((choice) => choice.instanceId);

    actions.push({
      type: 'OPEN_CARD',
      card: card.instanceId,
      pay: payment,
      ...(targets.length > 0 ? { targets } : {}),
    });
  }

  return actions;
}

/**
 * Finds one payment that satisfies a cost, or null if the hand cannot pay.
 *
 * Coloured icons are matched first, and each takes the card whose colour is
 * *least* in demand, so a hand that can pay is never reported as unable to.
 * The result is a suggestion — the player may submit any valid alternative,
 * and `reduce` validates whatever arrives.
 */
function choosePayment(
  ctx: EngineContext,
  cost: Parameters<typeof validatePayment>[1],
  hand: readonly CardInstance[],
): CardInstanceId[] | null {
  if (costTotal(cost) > hand.length) return null;

  const remaining = [...hand];
  const chosen: CardInstanceId[] = [];

  for (const icon of cost) {
    if (icon.color === 'any') continue;
    for (let i = 0; i < icon.count; i++) {
      const index = remaining.findIndex((card) => definitionOf(ctx, card).color === icon.color);
      if (index === -1) return null;
      const [card] = remaining.splice(index, 1);
      if (card) chosen.push(card.instanceId);
    }
  }

  const generic = cost.find((icon) => icon.color === 'any')?.count ?? 0;
  if (remaining.length < generic) return null;
  for (let i = 0; i < generic; i++) {
    const card = remaining[i];
    if (card) chosen.push(card.instanceId);
  }

  return chosen;
}

/** Rules.md §10 ④(2) — any card in hand may be set into any city. */
function setActions(state: GameState, hand: readonly CardInstance[]): GameAction[] {
  return hand.flatMap((card) =>
    state.cities.map((city) => ({
      type: 'SET_CARD' as const,
      card: card.instanceId,
      city: city.index,
    })),
  );
}

/** Rules.md §10 ④(1) — unlocked characters may move within their Move range. */
function moveActions(ctx: EngineContext, state: GameState, player: PlayerId): GameAction[] {
  const actions: GameAction[] = [];

  const characters = Object.values(state.cards).filter(
    (card) =>
      card.zone === 'city' &&
      card.faceUp &&
      !card.locked &&
      card.controller === player &&
      isCharacter(ctx, card),
  );

  for (const card of characters) {
    const from = card.cityIndex ?? -1;
    const move = moveOf(ctx, state, card);
    for (const city of state.cities) {
      if (city.index === from) continue;
      if (cityDistance(from, city.index) > move) continue;
      actions.push({ type: 'MOVE_CHARACTER', card: card.instanceId, city: city.index });
    }
  }

  return actions;
}

/** Convenience for the client: is this exact action currently offered? */
export function isLegal(
  ctx: EngineContext,
  state: GameState,
  player: PlayerId,
  action: GameAction,
): boolean {
  return legalActions(ctx, state, player).some(
    (candidate) => JSON.stringify(candidate) === JSON.stringify(action),
  );
}
