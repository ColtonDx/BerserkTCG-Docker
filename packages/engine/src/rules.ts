import type { CardDefinition, CardRegistry, Cost } from './cards.js';
import { costTotal, parseCost } from './cards.js';
import {
  counterFor,
  selects,
  SHIELD,
  usedOnTurnCounter,
  type Ability,
  type CardFacts,
  type Condition,
  type StatLine,
  type TargetSpec,
  type Trigger,
} from './abilities.js';
import type { Draft } from './draft.js';
import type { CardInstanceId, PlayerId } from './ids.js';
import { ok, violation, type Result, type RuleViolation } from './result.js';
import type { BattleResult, BattleState, CardInstance, GameEvent, GameState } from './types.js';
import { cardsInCity, cityDistance } from './zones.js';

/**
 * Derived rules — the questions the reducer keeps asking about a position.
 *
 * Everything here is a pure function of state (plus the card registry), so it
 * can be reused by `legalActions`, the UI, and a future AI without risk of the
 * three disagreeing.
 */

/** Card definitions are not part of `GameState`, so they travel alongside it. */
export interface EngineContext {
  readonly registry: CardRegistry;
}

/**
 * As much of the state as the derived rules read.
 *
 * Named rather than repeated, because a continuous ability can ask about the
 * board, the cities and whose turn it is, and every reader in the chain has
 * to admit that up front.
 */
export type BoardView = Pick<GameState, 'cards' | 'cities' | 'turn' | 'seats'>;

export const OCCUPATION_WIN_THRESHOLD = 3;
export const HAND_LIMIT = 7;

/**
 * Counter recording the turn a card was opened on, so "the turn it is opened"
 * can be asked later in that turn. Rules.md §7.
 */
export const OPENED_ON_TURN = 'openedOnTurn';

/**
 * A number that identifies *this* turn, not this round.
 *
 * `turn.turnNumber` counts rounds — both players share turn 1 — so a card
 * that came down on the opponent's turn 3 would otherwise still read as
 * "opened this turn" during your own turn 3. Folding in which seat is playing
 * gives a value that changes every time the turn passes and never repeats.
 */
export const turnOrdinal = (state: Pick<GameState, 'turn' | 'seats'>): number =>
  state.turn.turnNumber * 2 + Math.max(0, state.seats.indexOf(state.turn.activePlayer));

export const definitionOf = (ctx: EngineContext, card: CardInstance): CardDefinition =>
  ctx.registry.get(card.defId);

export const isCharacter = (ctx: EngineContext, card: CardInstance): boolean =>
  definitionOf(ctx, card).kind === 'character';

/**
 * City Level, the gate on which cards may be opened.
 *
 * A single shared value: the number of face-up cities anywhere on the table
 * (Rules.md §5, DesignNotes "Open Step" 1). It is deliberately *not* per-city
 * — flipping any city raises the level for opening cards in every city.
 */
export const cityLevel = (state: Pick<GameState, 'cities'>): number =>
  state.cities.filter((city) => city.faceUp).length;

/** Face-up characters a player has in a city. Presence drives city control. */
export const presenceIn = (
  ctx: EngineContext,
  state: Pick<GameState, 'cards'>,
  cityIndex: number,
  player: PlayerId,
): CardInstance[] =>
  cardsInCity(state, cityIndex, player).filter((card) => card.faceUp && isCharacter(ctx, card));

/**
 * Is a card of this name already face up on the field? Rules.md §8.
 *
 * Either side's — the rule is about the name existing at all, not about who
 * put it there — and it blocks the open outright rather than letting the card
 * flip and bounce back.
 *
 * A card whose name is unknown can never conflict. Two nameless cards would
 * otherwise "match" each other and lock each other out of the game.
 */
export function uniqueConflict(
  ctx: EngineContext,
  state: Pick<GameState, 'cards'>,
  def: CardDefinition,
): boolean {
  if (!def.unique || !def.name) return false;
  return Object.values(state.cards).some(
    (card) => card.zone === 'city' && card.faceUp && definitionOf(ctx, card).name === def.name,
  );
}

/**
 * Checks that `pay` exactly satisfies `cost`. Coloured icons need a card of
 * that colour; the multi icon takes any colour. Rules.md §7.
 *
 * Coloured requirements are matched first so that a payment which *could*
 * work is never rejected because an any-colour icon greedily consumed the one
 * matching card.
 */
export function validatePayment(
  ctx: EngineContext,
  cost: Cost,
  pay: readonly CardInstance[],
): Result<true, RuleViolation> {
  const required = costTotal(cost);
  if (pay.length !== required) {
    return violation(
      'INSUFFICIENT_RESOURCES',
      `This card costs ${required} card(s); you offered ${pay.length}.`,
      '§7',
    );
  }

  const remaining = [...pay];
  for (const icon of cost) {
    if (icon.color === 'any') continue;
    for (let i = 0; i < icon.count; i++) {
      const index = remaining.findIndex((card) => definitionOf(ctx, card).color === icon.color);
      if (index === -1) {
        return violation(
          'INSUFFICIENT_RESOURCES',
          `This card requires a ${icon.color} card as part of its cost.`,
          '§7',
        );
      }
      remaining.splice(index, 1);
    }
  }

  return ok(true);
}

/* ----------------------------------------------------------- board upkeep */

/**
 * Recomputes city face-up state and occupation after any board change.
 *
 * - A city is face-up exactly while a face-up character stands there (§5).
 * - An occupier that no longer has a character there loses the city (§12).
 *
 * Call this after every action that moves, destroys, or reveals a character.
 */
export function refreshBoard(
  ctx: EngineContext,
  draft: Draft<GameState>,
  events: GameEvent[],
): void {
  for (const city of draft.cities) {
    const present = cardsInCity(draft, city.index).filter(
      (card) => card.faceUp && isCharacter(ctx, card),
    );

    // A city is turned face up by being *attacked*, not by someone standing
    // in it — see `declareBattle`. Opening a character into an empty city
    // used to raise City Level on its own, which let a player climb the Level
    // ladder without ever contesting anything.
    if (city.occupiedBy) {
      const stillThere = present.some((card) => card.controller === city.occupiedBy);
      if (!stillThere) {
        city.occupiedBy = null;
        events.push({ type: 'CITY_OCCUPIED', city: city.index, player: null });
      }
    }
  }
}

/** Cities a player currently occupies. */
export const occupiedCities = (state: Pick<GameState, 'cities'>, player: PlayerId): number[] =>
  state.cities.filter((city) => city.occupiedBy === player).map((city) => city.index);

/**
 * Occupation victory: 3+ cities at once, including the Royal Capital.
 * Rules.md §1.
 */
export function occupationWinner(state: Pick<GameState, 'cities' | 'seats'>): PlayerId | null {
  for (const seat of state.seats) {
    const held = state.cities.filter((city) => city.occupiedBy === seat);
    const hasCapital = held.some((city) => city.royalCapital);
    if (hasCapital && held.length >= OCCUPATION_WIN_THRESHOLD) return seat;
  }
  return null;
}

/** Ends the match if someone has met a win condition. Returns true if it did. */
export function checkWinConditions(draft: Draft<GameState>, events: GameEvent[]): boolean {
  const winner = occupationWinner(draft);
  if (!winner) return false;

  draft.status = { kind: 'finished', winner, reason: 'occupation' };
  events.push({ type: 'MATCH_ENDED', winner, reason: 'occupation' });
  return true;
}

/* ------------------------------------------------------------------ battle */

/**
 * Characters a player has in a city that could still fight — face up, and
 * not already destroyed. Lock state is deliberately not considered here:
 * whether a locked character may be committed depends on the step and on who
 * occupies the city (Rules.md §11 ③).
 */
export const fightersIn = (
  ctx: EngineContext,
  state: Pick<GameState, 'cards'>,
  cityIndex: number,
  player: PlayerId,
): CardInstance[] => presenceIn(ctx, state, cityIndex, player);

/**
 * A character's numbers as they stand right now.
 *
 * Three things move them, and all three are read here rather than written
 * onto the card, so nothing can drift: the printed value, any continuous
 * ability on the board that reaches this card (Rules.md §13), and boosts
 * written on it by an ability that has already resolved. Range is printed
 * only — nothing in the set moves it yet.
 *
 * Never below zero: a character reduced past nothing has nothing, and a
 * negative Power would quietly heal whatever it struck.
 */
const statOf = (
  ctx: EngineContext,
  state: BoardView,
  card: CardInstance,
  stat: 'power' | 'hp' | 'move',
): number => {
  const printed = definitionOf(ctx, card).stats?.[stat] ?? 0;
  const boost = card.counters[counterFor(stat)] ?? 0;
  return Math.max(0, printed + boost + continuousBonus(ctx, state, card, stat));
};

export const powerOf = (ctx: EngineContext, state: BoardView, card: CardInstance): number =>
  statOf(ctx, state, card, 'power');

export const hpOf = (ctx: EngineContext, state: BoardView, card: CardInstance): number =>
  statOf(ctx, state, card, 'hp');

/** How far it can travel in one move. Rules.md §10 ④. */
export const moveOf = (ctx: EngineContext, state: BoardView, card: CardInstance): number =>
  statOf(ctx, state, card, 'move');

/** A character's printed Range, which sets when it strikes. Rules.md §11 ④. */
export const rangeOf = (ctx: EngineContext, card: CardInstance): number =>
  definitionOf(ctx, card).stats?.range ?? 0;

/**
 * Everything continuously changing this card's numbers, summed.
 *
 * Continuous abilities are not stored anywhere — they are the board. Reading
 * them fresh each time is what makes them behave: Griffith's aura stops the
 * instant he leaves the area, without anything having to remember to undo it.
 */
function continuousBonus(
  ctx: EngineContext,
  state: BoardView,
  card: CardInstance,
  stat: keyof StatLine,
): number {
  let total = 0;
  for (const source of Object.values(state.cards)) {
    if (source.zone !== 'city' || !source.faceUp) continue;
    for (const ability of definitionOf(ctx, source).abilities ?? []) {
      if (ability.trigger !== 'always' || ability.effect.do !== 'buff') continue;
      const change = ability.effect.stats[stat];
      if (change === undefined) continue;
      if (!selects(ability.effect.who, source, card, (c) => factsOf(ctx, c))) continue;
      if (!conditionHolds(ctx, state, source, ability.condition)) continue;
      total += change;
    }
  }
  return total;
}

/**
 * How much of a blow this card shrugs off. Rules.md §13.
 *
 * Two sources add together: armour read continuously off the board (Serpico
 * standing there is the whole condition) and a shield written onto the card
 * for the turn by an effect that has already resolved. `combat` says which
 * kind of damage is landing, because a card that reduces damage "during
 * combat" is silent about a spell.
 *
 * Never negative: a reduction is a floor on the damage, not a way to amplify.
 */
export function damageReduction(
  ctx: EngineContext,
  state: BoardView,
  card: CardInstance,
  options: { combat: boolean },
): number {
  let total = card.counters[SHIELD] ?? 0;
  for (const source of Object.values(state.cards)) {
    if (source.zone !== 'city' || !source.faceUp) continue;
    for (const ability of definitionOf(ctx, source).abilities ?? []) {
      if (ability.trigger !== 'always' || ability.effect.do !== 'reduceDamage') continue;
      if (ability.effect.combatOnly === true && !options.combat) continue;
      if (!selects(ability.effect.who, source, card, (c) => factsOf(ctx, c))) continue;
      if (!conditionHolds(ctx, state, source, ability.condition)) continue;
      total += ability.effect.amount;
    }
  }
  return Math.max(0, total);
}

/** What actually lands after {@link damageReduction}. Never below nothing. */
export const damageAfterReduction = (
  ctx: EngineContext,
  state: BoardView,
  card: CardInstance,
  amount: number,
  options: { combat: boolean },
): number => Math.max(0, amount - damageReduction(ctx, state, card, options));

/**
 * Which cards on the field are continuously changing this one's numbers.
 *
 * Rules.md §13's cost-free abilities are not stored anywhere — they *are* the
 * board — so nothing in the state says "Griffith is lifting this Hawk". The
 * client cannot work it out either, because which cards an ability reaches is
 * engine data. Reading it back off the same loop `continuousBonus` walks is
 * what lets the table show the connection.
 *
 * Only sources that actually move a number: an ability whose stats all resolve
 * to zero for this card is not a relationship worth drawing.
 */
export function boostSources(
  ctx: EngineContext,
  state: BoardView,
  card: CardInstance,
): CardInstanceId[] {
  const found: CardInstanceId[] = [];
  for (const source of Object.values(state.cards)) {
    if (source.zone !== 'city' || !source.faceUp) continue;
    if (source.instanceId === card.instanceId) continue;
    for (const ability of definitionOf(ctx, source).abilities ?? []) {
      if (ability.trigger !== 'always' || ability.effect.do !== 'buff') continue;
      const stats = ability.effect.stats;
      if (!stats.power && !stats.hp && !stats.move) continue;
      if (!selects(ability.effect.who, source, card, (c) => factsOf(ctx, c))) continue;
      if (!conditionHolds(ctx, state, source, ability.condition)) continue;
      if (!found.includes(source.instanceId)) found.push(source.instanceId);
      break;
    }
  }
  return found;
}

/** The printed subtype tokens of a card, e.g. `['hawk', 'leader']`. */
export const subtypesOf = (ctx: EngineContext, card: CardInstance): readonly string[] =>
  definitionOf(ctx, card).subtypes ?? [];

/** Everything a selector asks about a card, from its printed definition. */
export const factsOf = (ctx: EngineContext, card: CardInstance): CardFacts => {
  const def = definitionOf(ctx, card);
  return { subtypes: def.subtypes ?? [], level: def.level, colour: def.color };
};

/**
 * The characters an ability may be pointed at. Rules.md §13.
 *
 * Face-up characters only: a face-down Set Card has no presence to be
 * affected, and neither does one in a hand. An empty list means the ability
 * has nothing to do — which is not the same as the card being unopenable, so
 * the open still goes ahead and the ability simply finds nobody.
 */
export function legalTargets(
  ctx: EngineContext,
  state: BoardView,
  source: CardInstance,
  spec: TargetSpec,
  /** The battle in progress, for a spec that asks who is "currently in combat". */
  battle?: BattleState | null,
): CardInstance[] {
  return Object.values(state.cards).filter((card) => {
    // The source counts as face-up whatever the board says right now. An
    // on-open ability is offered while its own card is still a face-down Set
    // Card, but it resolves a moment later with that card standing in the
    // area — so a lone character that targets "1 character in this area"
    // means itself, and offering nothing would make it do nothing.
    const standing = card.faceUp || card.instanceId === source.instanceId;
    if (card.zone !== 'city' || !standing || !isCharacter(ctx, card)) return false;
    // "Target another character" — Rules.md §13.
    if (spec.excludeSelf === true && card.instanceId === source.instanceId) return false;
    const side = spec.side ?? 'any';
    if (side === 'yours' && card.controller !== source.controller) return false;
    if (side === 'theirs' && card.controller === source.controller) return false;
    // Distance widens "this area" rather than replacing it: the source's own
    // city is distance 0, so it is always in reach. Rules.md §15 "Distance".
    if (spec.maxDistance !== undefined) {
      if (card.cityIndex === undefined || source.cityIndex === undefined) return false;
      if (cityDistance(source.cityIndex, card.cityIndex) > spec.maxDistance) return false;
    } else if ((spec.where ?? 'thisArea') === 'thisArea' && card.cityIndex !== source.cityIndex) {
      return false;
    }
    if (spec.subtype !== undefined && !subtypesOf(ctx, card).includes(spec.subtype)) return false;
    if (spec.unlocked === true && card.locked) return false;
    // Rules.md §11 ③ — the participants, not merely everyone standing in the
    // contested city. With no battle on, nobody is in combat.
    if (spec.inCombat === true && !battle?.participants.includes(card.instanceId)) return false;
    const def = definitionOf(ctx, card);
    if (spec.colour !== undefined && def.color !== spec.colour) return false;
    if (spec.maxLevel !== undefined && (def.level === null || def.level > spec.maxLevel)) {
      return false;
    }
    return true;
  });
}

/* ------------------------------------------------------- activated abilities
 *
 * Rules.md §13: a cost-bearing ability is used by choice and paid for. The
 * timing is the printed distinction — "usable only in your own Main phase,
 * unless the ability has Quick".
 */

/** An ability the player may choose to use, with the index the wire names it by. */
export interface ActivatedAbility {
  readonly index: number;
  readonly ability: Ability;
}

export const activatedAbilities = (ctx: EngineContext, card: CardInstance): ActivatedAbility[] =>
  (definitionOf(ctx, card).abilities ?? [])
    .map((ability, index) => ({ index, ability }))
    .filter((entry) => entry.ability.trigger === 'activated');

/**
 * Has this ability already been used this turn? Rules.md §13.
 *
 * Compared against the turn number rather than cleared at end of turn, so a
 * card that leaves the field and comes back cannot carry a stale mark.
 */
export const usedThisTurn = (state: BoardView, card: CardInstance, index: number): boolean =>
  card.counters[usedOnTurnCounter(index)] === turnOrdinal(state);

/**
 * May this player use this ability right now? Rules.md §13.
 *
 * Timing only — what it *costs* is checked against the hand and the board by
 * the caller, which has to choose a payment anyway.
 */
export function canActivate(
  ctx: EngineContext,
  state: GameState,
  card: CardInstance,
  entry: ActivatedAbility,
  player: PlayerId,
): boolean {
  // §13 — abilities are "active only while the card is on the field".
  if (card.zone !== 'city' || !card.faceUp) return false;
  if (card.controller !== player) return false;
  if (usedThisTurn(state, card, entry.index)) return false;
  if (entry.ability.cost?.lockSelf === true && card.locked) return false;
  if (!conditionHolds(ctx, state, card, entry.ability.condition, state.battle)) return false;

  // An ability that must be pointed at somebody, with nobody to point at, is
  // not a move — offering it would spend the cost for nothing.
  if (
    entry.ability.target &&
    legalTargets(ctx, state, card, entry.ability.target, state.battle).length === 0
  ) {
    return false;
  }
  if (
    entry.ability.cost?.lockAlly &&
    legalTargets(ctx, state, card, entry.ability.cost.lockAlly, state.battle).length === 0
  ) {
    return false;
  }

  // A Quick ability rides the same windows a Quick card does: `state.quick`
  // is where an interrupt lives, and DesignNotes "When to offer a Quick" says
  // when one opens. Anything looser would let a Quick ability be used at
  // moments the engine never offers, and `legalActions` would stop matching
  // what `reduce` accepts.
  if (state.quick !== null) {
    return entry.ability.quick === true && state.quick.waitingOn === player;
  }
  if (state.battle !== null) return false;

  // Otherwise §13's plain rule: your own Main phase. Read inline rather than
  // through `currentPhase`, which lives in the reducer — the rules must not
  // depend on it, or the two would import each other.
  return (
    state.turn.activePlayer === player &&
    state.turn.priorityPlayer === player &&
    state.phases[state.turn.phaseIndex]?.id === 'main'
  );
}

/** The cost of an activated ability, in the notation `validatePayment` reads. */
export const activationCost = (ability: Ability): Cost =>
  ability.cost?.pay === undefined ? [] : parseCost(ability.cost.pay);

/** The abilities on a card that will ask the player to choose, in order. */
export type TargetingAbility = Ability & { readonly target: TargetSpec };

export const targetingAbilities = (
  ctx: EngineContext,
  card: CardInstance,
  trigger: Trigger,
): TargetingAbility[] =>
  (definitionOf(ctx, card).abilities ?? []).filter(
    (ability): ability is TargetingAbility =>
      ability.trigger === trigger && ability.target !== undefined,
  );

/**
 * Is this card forbidden from attacking? Rules.md §11.
 *
 * Asked of continuous abilities only, because a restriction has to hold for
 * as long as it is printed rather than being applied once.
 */
export function cannotAttack(ctx: EngineContext, state: BoardView, card: CardInstance): boolean {
  for (const source of Object.values(state.cards)) {
    if (source.zone !== 'city' || !source.faceUp) continue;
    for (const ability of definitionOf(ctx, source).abilities ?? []) {
      if (ability.trigger !== 'always' || ability.effect.do !== 'cannotAttack') continue;
      if (!selects(ability.effect.who, source, card, (c) => factsOf(ctx, c))) continue;
      if (conditionHolds(ctx, state, source, ability.condition)) return true;
    }
  }
  return false;
}

/**
 * Does an ability's condition hold for the card carrying it?
 *
 * The battle-shaped conditions are answered by the caller through
 * `battleContext`, because a continuous read has no battle to look at while
 * an on-attack trigger has exactly one.
 */
export function conditionHolds(
  ctx: EngineContext,
  state: Pick<GameState, 'cards' | 'cities' | 'turn' | 'seats'>,
  source: CardInstance,
  condition: Condition | undefined,
  battle?: BattleState | null,
): boolean {
  if (!condition) return true;

  switch (condition.when) {
    case 'youControlName': {
      return Object.values(state.cards).some(
        (card) =>
          card.controller === source.controller &&
          card.zone === 'city' &&
          card.faceUp &&
          definitionOf(ctx, card).name === condition.name,
      );
    }
    case 'openedThisTurn':
      return source.counters[OPENED_ON_TURN] === turnOrdinal(state);
    case 'youOccupyThisArea':
      return cityOf(state, source)?.occupiedBy === source.controller;
    case 'enemyOccupiesThisArea': {
      const holder = cityOf(state, source)?.occupiedBy;
      return holder !== null && holder !== undefined && holder !== source.controller;
    }
    case 'isVanguard':
      return battle?.vanguard === source.instanceId;
    case 'attackingOccupiedArea': {
      if (!battle || battle.attacker !== source.controller) return false;
      const city = state.cities[battle.city];
      return city?.occupiedBy === battle.defender;
    }
  }
}

const cityOf = (
  state: Pick<GameState, 'cities'>,
  card: CardInstance,
): GameState['cities'][number] | undefined =>
  card.cityIndex === undefined ? undefined : state.cities[card.cityIndex];

/**
 * The participants that strike next, as one Range band.
 *
 * Damage runs highest Range first and resolves a band at a time, so this
 * returns everyone sharing the highest Range still to act. Within the band
 * the attacker assigns first, but the damage lands together — which is why
 * the band is returned whole rather than one character at a time.
 * Rules.md §11 ④.
 */
export function nextRangeBand(
  ctx: EngineContext,
  state: Pick<GameState, 'cards'>,
  battle: BattleState,
): CardInstanceId[] {
  const alive = battle.participants
    .filter((id) => !battle.struck.includes(id))
    .map((id) => state.cards[id])
    .filter((card): card is CardInstance => card !== undefined && card.zone === 'city');
  if (alive.length === 0) return [];

  const top = Math.max(...alive.map((card) => rangeOf(ctx, card)));
  const band = alive.filter((card) => rangeOf(ctx, card) === top);
  // Ties assign attacker-first (§11 ④), so order the band that way.
  return [
    ...band.filter((card) => card.controller === battle.attacker),
    ...band.filter((card) => card.controller !== battle.attacker),
  ].map((card) => card.instanceId);
}

/**
 * Which way the battle went, from who is left of the two sides that *fought*.
 * Rules.md §12.
 *
 * Participants, not everyone standing in the city. A defender may open, look
 * at what is coming, and commit nobody — and that hands the city over. Their
 * uncommitted characters stay where they are; they simply took no part, and
 * a battle is decided by the people in it.
 */
export function battleResult(
  ctx: EngineContext,
  state: Pick<GameState, 'cards'>,
  battle: BattleState,
): BattleResult {
  const standing = (player: PlayerId): number =>
    battle.participants.filter((id) => {
      const card = state.cards[id];
      return card !== undefined && card.zone === 'city' && card.controller === player;
    }).length;

  const attackers = standing(battle.attacker);
  const defenders = standing(battle.defender);

  if (attackers > 0 && defenders === 0) return 'occupation';
  if (defenders > 0 && attackers === 0) return 'repel';
  if (attackers === 0 && defenders === 0) return 'mutual_destruction';
  return 'stalemate';
}

/** Characters that could lead the attack: yours, there, face up and unlocked. */
export function canVanguard(
  ctx: EngineContext,
  state: BoardView,
  player: PlayerId,
  cityIndex: number,
): CardInstance[] {
  return presenceIn(ctx, state, cityIndex, player).filter(
    (card) => !card.locked && !cannotAttack(ctx, state, card),
  );
}

/**
 * Characters that may still be committed. Rules.md §11 ③ — normally unlocked
 * ones only, but a defender who occupies the city commits everything, so by
 * the time this is asked their garrison is already in.
 */
export function canCommit(
  ctx: EngineContext,
  state: BoardView,
  battle: BattleState,
  player: PlayerId,
): CardInstance[] {
  return presenceIn(ctx, state, battle.city, player).filter(
    (card) =>
      !card.locked &&
      !battle.participants.includes(card.instanceId) &&
      // A character forbidden to attack may still defend: the restriction is
      // on attacking, and the defender is not. Rules.md §11.
      !(player === battle.attacker && cannotAttack(ctx, state, card)),
  );
}
