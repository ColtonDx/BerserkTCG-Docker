import { abilityKey } from './abilities.js';
import { costTotal } from './cards.js';
import type { CardInstanceId, PlayerId } from './ids.js';
import { currentPhase } from './reducer.js';
import {
  activatedAbilities,
  activationCost,
  areasFor,
  abilitiesOf,
  altersFor,
  askingAbilities,
  conditionHolds,
  settable,
  canActivate,
  canCommit,
  canVanguard,
  legalTargets,
  moveOf,
  powerOf,
  quickCardRelevant,
  quickRelevant,
  cityLevel,
  openLevelFor,
  definitionOf,
  isCharacter,
  searchable,
  uniqueConflict,
  validatePayment,
  HAND_LIMIT,
  type EngineContext,
} from './rules.js';
import { SEALED } from './abilities.js';
import { MIN_KEPT_HAND } from './setup.js';
import type { BattleState, CardInstance, GameAction, GameState, PendingChoice } from './types.js';
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

  // An effect that stopped to ask outranks even a Quick window: the window is
  // a question the player may decline, this is one they may not, because the
  // card is already half-resolved. Rules.md §13.
  if (state.pending) {
    if (state.pending.waitingOn !== player) return actions;
    actions.push(...choosable(ctx, state, state.pending, player));
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
      // §13 — a cost-bearing ability is used in its controller's Main phase.
      actions.push(...abilityActions(ctx, state, player));
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
 * Every card that answers the outstanding choice. Rules.md §13.
 *
 * A deck search reads the same list the view reveals (`searchable`), so what
 * the client is offered and what it is allowed to see are one decision made in
 * one place — offering a card the view had redacted would show the player a
 * hole in their own deck, and revealing one the reducer would refuse would be
 * worse.
 */
function choosable(
  ctx: EngineContext,
  state: GameState,
  pending: PendingChoice,
  player: PlayerId,
): GameAction[] {
  const kind = pending.kind;
  const actions: GameAction[] = [];
  if (kind.zone === 'decision') {
    // A yes or a no, and nothing else.
    return [
      { type: 'ANSWER', accept: true },
      { type: 'ANSWER', accept: false },
    ];
  }
  const cards =
    kind.zone === 'hand'
      ? kind.action === 'setAndOpen'
        ? settable(ctx, state, player, kind.maxLevel)
        : cardsInZone(state, player, 'hand')
      : kind.zone === 'field'
        ? // Worked out when the question was posed, so the Distance and
          // occupation checks are not re-run against a board that has moved.
          [...kind.cards, ...(kind.action === 'pay' ? (kind.hand ?? []) : [])]
            .map((id) => state.cards[id])
            .filter(
              (card): card is CardInstance =>
                card !== undefined && (card.zone === 'city' || card.zone === 'hand'),
            )
        : kind.zone === 'deckTop'
          ? // The cards still waiting to be named, in the order they lie.
            kind.cards
              .map((id) => state.cards[id])
              .filter((card): card is CardInstance => card !== undefined && card.zone === 'deck')
          : searchable(
              ctx,
              state,
              player,
              kind.named,
              kind.characterOnly,
              kind.includeTrash === true,
              kind.topOfDeck,
            );
  // "Set them anywhere" is a card *and* a destination, so every legal pair is
  // offered — the client cannot know which cities count (BK1-155).
  if (kind.zone === 'deck' && kind.action === 'toCityAnywhere') {
    // Where the printed line narrows where it may go (BK2-002), only those.
    const cities = kind.cities ?? state.cities.map((city) => city.index);
    for (const card of cards) {
      for (const city of cities) {
        actions.push({ type: 'CHOOSE_CARD', card: card.instanceId, city });
      }
    }
  } else {
    actions.push(...cards.map((card) => ({ type: 'CHOOSE_CARD' as const, card: card.instanceId })));
  }
  // "Up to": the player may stop here. A choice with nothing left to pick
  // from is stopped by the engine itself, so this is only ever a real option.
  if (pending.upTo && cards.length > 0) actions.push({ type: 'ANSWER', accept: false });
  return actions;
}

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
  return [
    // Only the cards worth opening *now* — see `rules.ts:quickRelevant`. A
    // Quick set on the table that could do nothing at this moment is not
    // offered, so a window opening means there is a real decision in it.
    ...openActions(ctx, state, player, hand, { ignoreTurnLimit: true, quickOnly: true }).filter(
      (action) => {
        const card = action.type === 'OPEN_CARD' ? state.cards[action.card] : undefined;
        return card !== undefined && quickCardRelevant(ctx, state, card);
      },
    ),
    // Rules.md §13 puts Quick abilities on the same footing as Quick cards:
    // both are usable at any time, so a window is worth offering for either.
    ...abilityActions(ctx, state, player, { quickOnly: true }),
  ];
}

/**
 * Cost-bearing abilities this player may use right now. Rules.md §13.
 *
 * `canActivate` decides the timing, so this only has to find the cards and
 * work out whether each cost can actually be met — an ability whose price
 * cannot be paid is never offered, exactly like an unopenable card.
 */
function abilityActions(
  ctx: EngineContext,
  state: GameState,
  player: PlayerId,
  scope: { quickOnly?: boolean } = {},
): GameAction[] {
  const hand = cardsInZone(state, player, 'hand');
  const actions: GameAction[] = [];

  for (const card of Object.values(state.cards)) {
    if (card.zone !== 'city' || !card.faceUp || card.controller !== player) continue;

    for (const entry of activatedAbilities(ctx, card)) {
      if (scope.quickOnly === true && entry.ability.quick !== true) continue;
      if (scope.quickOnly === true && !quickRelevant(ctx, state, card, entry.ability)) continue;
      if (!canActivate(ctx, state, card, entry, player)) continue;

      const payment = choosePayment(ctx, activationCost(entry.ability), hand);
      if (!payment) continue;

      // The cost's chosen ally comes first and the effect's target second,
      // which is the order `reduce` reads them back in. The ally is settled
      // here as a suggestion; the effect's target is offered one action per
      // choice, so the board can light up the legal ones.
      const prefix: CardInstanceId[] = [];
      const lockAlly = entry.ability.cost?.lockAlly;
      if (lockAlly) {
        const ally = legalTargets(ctx, state, card, lockAlly, state.battle)[0];
        if (!ally) continue;
        prefix.push(ally.instanceId);
      }
      // The character spent to pay comes first too, ahead of any target for
      // the effect: a cost is settled before what it buys (BK2-041).
      const destroyAlly = entry.ability.cost?.destroyAlly;
      if (destroyAlly) {
        const doomed = legalTargets(ctx, state, card, destroyAlly, state.battle)[0];
        if (!doomed) continue;
        prefix.push(doomed.instanceId);
      }

      const aims = entry.ability.target
        ? legalTargets(ctx, state, card, entry.ability.target, state.battle).map(
            (option) => option.instanceId,
          )
        : [undefined];
      // `canActivate` already refuses an ability with nobody to point at, so
      // an empty list here means the ability asks for nobody at all.
      for (const aim of aims) {
        const choices = aim === undefined ? prefix : [...prefix, aim];
        // An ability that also asks for an area gets one offer per legal
        // (character, area) pair, exactly as the on-open path does — the
        // client cannot work out what "within distance 2" reaches.
        const areas =
          entry.ability.area === undefined
            ? [undefined]
            : areasFor(ctx, state, entry.ability.area, card, aim);
        for (const area of areas) {
          actions.push({
            type: 'USE_ABILITY',
            card: card.instanceId,
            ability: abilityKey(entry.index),
            ...(choices.length > 0 ? { targets: choices } : {}),
            ...(area !== undefined ? { areas: [area] } : {}),
            ...(payment.length > 0 ? { pay: payment } : {}),
          });
        }
      }
    }
  }

  return actions;
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
    // Shut for the turn by a card that said so (BK1-031). Rules.md §7.
    if ((card.counters[SEALED] ?? 0) > 0) continue;
    if (def.level > openLevelFor(ctx, state, player)) continue;

    // Alteration pays with a body instead of the printed cost (§7), so a
    // card that cannot be afforded from hand may still be openable — and a
    // Unique already on the field is no obstacle when *that* card is the one
    // being sacrificed, which is what the keyword is for (§8).
    const alters = altersFor(ctx, state, card).filter(
      (body) => !uniqueConflict(ctx, state, def, body.instanceId),
    );
    const affordable = uniqueConflict(ctx, state, def)
      ? undefined
      : choosePayment(ctx, def.cost, hand);
    if (!affordable && alters.length === 0) continue;
    const payment = affordable ?? [];

    // Everything below builds this card's offers once, against the cost it
    // would pay from hand. `routes` then repeats them for each Alteration —
    // the choice of *how* to pay is orthogonal to targets and areas, and
    // duplicating the enumeration for it would be a second place to get the
    // targeting rules wrong.
    const before = actions.length;

    // "This card can only be opened if …" — a shut gate is not an offer.
    // Rules.md §13, `Ability.gate`.
    const gated = abilitiesOf(ctx, card).some(
      (ability) =>
        ability.trigger === 'open' &&
        ability.gate === true &&
        !conditionHolds(ctx, state, card, ability.condition, state.battle),
    );
    if (gated) continue;

    const asking = askingAbilities(ctx, card, 'open');

    // One open per legal target, rather than one open carrying a suggestion.
    //
    // The client renders what it is offered (see the note at the top of this
    // file), and it cannot work a target list out for itself: which characters
    // a card may point at depends on colour, Level, Distance and whether a
    // battle is running — rules that live here. Offering each choice as its
    // own action is what lets the board light up exactly the legal ones.
    //
    // Only for a card with a single asking ability, which is every one in the
    // set today. A card with two would need the cross-product, so it keeps the
    // older behaviour of one suggested target each and the reducer still
    // accepts any other legal combination.
    if (asking.length === 1) {
      const ability = asking[0] as (typeof asking)[number];
      // An ability that asks only for an area gets one offer per area
      // (BK1-068: "move all your set cards from this area to any other").
      if (ability.target === undefined && ability.area !== undefined) {
        const areas = areasFor(ctx, state, ability.area, card);
        if (areas.length === 0) {
          actions.push({ type: 'OPEN_CARD', card: card.instanceId, pay: payment });
        }
        for (const area of areas) {
          actions.push({ type: 'OPEN_CARD', card: card.instanceId, pay: payment, areas: [area] });
        }
        continue;
      }
      const options = ability.target
        ? legalTargets(ctx, state, card, ability.target, state.battle)
        : [];
      // A line naming one character from each side offers every legal pair
      // (BK2-029) — the client cannot work out which combinations are legal.
      const seconds = ability.target2
        ? legalTargets(ctx, state, card, ability.target2, state.battle)
        : [];
      if (ability.target2 && seconds.length === 0) {
        // "Must have valid targets for both": with nobody on one side the
        // line does nothing, so it is offered with no targets at all.
        actions.push({ type: 'OPEN_CARD', card: card.instanceId, pay: payment });
        continue;
      }
      // Nobody to point at is not a reason to refuse the open: the ability
      // resolves and finds nobody (Rules.md §13).
      if (options.length === 0) {
        actions.push({ type: 'OPEN_CARD', card: card.instanceId, pay: payment });
      } else {
        for (const option of options) {
          if (ability.target2) {
            for (const second of seconds) {
              if (second.instanceId === option.instanceId) continue;
              // The area, where the line also asks for one — both travellers
              // go to the same one (BK2-029), so it is chosen once per pair.
              const pairAreas =
                ability.area === undefined
                  ? [undefined]
                  : areasFor(ctx, state, ability.area, card, option.instanceId);
              for (const area of pairAreas.length > 0 ? pairAreas : [undefined]) {
                actions.push({
                  type: 'OPEN_CARD',
                  card: card.instanceId,
                  pay: payment,
                  targets: [option.instanceId, second.instanceId],
                  ...(area === undefined ? {} : { areas: [area] }),
                });
              }
            }
            continue;
          }
          // An ability that also asks for an area gets one offer per legal
          // (character, area) pair — "move it to an adjacent area" is two
          // different plays at a middle city, and the client cannot work out
          // which areas count without knowing what "adjacent" means.
          const areas =
            ability.area === undefined
              ? [undefined]
              : areasFor(ctx, state, ability.area, card, option.instanceId);
          for (const area of areas.length > 0 ? areas : [undefined]) {
            actions.push({
              type: 'OPEN_CARD',
              card: card.instanceId,
              pay: payment,
              targets: [option.instanceId],
              ...(area === undefined ? {} : { areas: [area] }),
            });
          }
        }
      }
      continue;
    }

    const targets = asking
      .map((ability) =>
        ability.target
          ? legalTargets(ctx, state, card, ability.target, state.battle)[0]
          : undefined,
      )
      .filter((choice): choice is CardInstance => choice !== undefined)
      .map((choice) => choice.instanceId);

    actions.push({
      type: 'OPEN_CARD',
      card: card.instanceId,
      pay: payment,
      ...(targets.length > 0 ? { targets } : {}),
    });

    fanOutAlterations(actions, before, alters, affordable !== undefined);
  }

  return actions;
}

/**
 * Repeats the offers made for one card, once per character that could pay
 * its Alteration. Rules.md §7.
 *
 * The offers from `from` onwards are this card's, built against the printed
 * cost; each is copied with `alter` set and `pay` emptied, because an
 * Alteration pays a body *instead of* the cost. When the cost could not be
 * afforded from hand at all, the originals are dropped — they were only
 * built so that targets and areas would be enumerated in one place.
 */
function fanOutAlterations(
  actions: GameAction[],
  from: number,
  alters: readonly CardInstance[],
  affordable: boolean,
): void {
  if (alters.length === 0) return;
  const mine = actions.slice(from).filter((a) => a.type === 'OPEN_CARD');
  if (!affordable) actions.length = from;
  for (const alter of alters) {
    for (const offer of mine) {
      actions.push({ ...offer, pay: [], alter: alter.instanceId });
    }
  }
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
