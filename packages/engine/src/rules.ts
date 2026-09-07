import type { CardDefinition, CardRegistry, Cost } from './cards.js';
import { costTotal, parseCost } from './cards.js';
import {
  counterFor,
  selects,
  NEGATED,
  PERMANENT_HP,
  PERMANENT_POWER,
  NO_BATTLE,
  REARGUARD,
  SEALED,
  ALTERED,
  CHARGES,
  SHIELD,
  WARD,
  usedOnTurnCounter,
  type Ability,
  type AreaKind,
  type CardFacts,
  type Condition,
  type Effect,
  type Grants,
  type Selector,
  type StatLine,
  type TargetSpec,
  type Trigger,
} from './abilities.js';
import type { Draft } from './draft.js';
import type { CardInstanceId, PlayerId } from './ids.js';
import { ok, violation, type Result, type RuleViolation } from './result.js';
import type { BattleResult, BattleState, CardInstance, GameEvent, GameState } from './types.js';
import { cardsInCity, cityDistance, moveToZone, zoneKey } from './zones.js';

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
/**
 * A card's abilities, or none at all if it has been silenced. Rules.md §14.
 *
 * **Every** ability lookup goes through this rather than reading
 * `definitionOf(...).abilities` directly, which is the whole point:
 * negation (BK1-151) applied at some lookups and not others would be
 * silently wrong exactly where it was forgotten, and nothing would fail.
 */
/**
 * Does anything on the board lock a character as it is opened? Rules.md §6,
 * §7 — BK2-046, "when characters are opened, they become locked".
 *
 * Read off the board rather than written down, like every other continuous
 * ability: the moment the card leaves, opens stop being punished.
 */
export function opensLocked(ctx: EngineContext, state: Pick<GameState, 'cards'>): boolean {
  for (const source of Object.values(state.cards)) {
    if (source.zone !== 'city' || !source.faceUp) continue;
    for (const ability of abilitiesOf(ctx, source)) {
      if (ability.trigger !== 'always') continue;
      if (ability.effect.do === 'openedCardsLock') return true;
    }
  }
  return false;
}

/**
 * Is this card beyond the reach of an ability's choice? Rules.md §13 —
 * BK3-019, "cannot be targetted by abilities".
 *
 * Read off the board like every other continuous ability, and asked by
 * `legalTargets` so such a card is simply never offered.
 */
/**
 * Does this card print Alteration? Rules.md §7.
 *
 * Carried on an ability entry because the registry is keyed that way, but
 * it is a property of the *card* — any entry declaring it makes the card
 * alterable.
 */
export const hasAlteration = (ctx: EngineContext, card: CardInstance): boolean =>
  abilitiesOf(ctx, card).some((ability) => ability.alteration === true);

/**
 * The characters that could pay this card's Alteration. Rules.md §7.
 *
 * "Sacrificing another creature of the same type in the same area" — same
 * printed *name*, so any printing of Guts alters into any other, standing
 * face up in the city this card is set in, and never the card itself.
 *
 * The single implementation, so `legalActions` and `reduce` cannot disagree
 * about what may be spent.
 */
export function altersFor(
  ctx: EngineContext,
  state: Pick<GameState, 'cards'>,
  card: CardInstance,
): CardInstance[] {
  if (!hasAlteration(ctx, card)) return [];
  const name = definitionOf(ctx, card).name;
  return Object.values(state.cards).filter(
    (other) =>
      other.zone === 'city' &&
      other.faceUp &&
      other.cityIndex === card.cityIndex &&
      other.controller === card.controller &&
      other.instanceId !== card.instanceId &&
      isCharacter(ctx, other) &&
      definitionOf(ctx, other).name === name,
  );
}

export function untargetable(
  ctx: EngineContext,
  state: Pick<GameState, 'cards'>,
  card: CardInstance,
): boolean {
  for (const source of Object.values(state.cards)) {
    if (source.zone !== 'city' || !source.faceUp) continue;
    for (const ability of abilitiesOf(ctx, source)) {
      if (ability.trigger !== 'always' || ability.effect.do !== 'untargetable') continue;
      if (!selects(ability.effect.who, source, card, (c) => factsOf(ctx, c, state))) continue;
      return true;
    }
  }
  return false;
}

export function abilitiesOf(ctx: EngineContext, card: CardInstance): readonly Ability[] {
  if ((card.counters[NEGATED] ?? 0) > 0) return [];
  return definitionOf(ctx, card).abilities ?? [];
}

export type BoardView = Pick<GameState, 'cards' | 'cities' | 'turn' | 'seats'> & {
  /**
   * The battle in progress, when the caller has one to hand. Optional so the
   * narrowed views that predate it still satisfy the type; a bonus that only
   * counts during a fight (BK1-029) simply does not apply without it.
   */
  readonly battle?: BattleState | null;
};

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

/**
 * The City Level a player may open against. Rules.md §5, §7.
 *
 * Normally just {@link cityLevel}, but a card on the board can narrow it for
 * one player (BK1-116). Read off the board rather than stored: City Level is
 * defined as the number of face-up cities and stays that, so what a card
 * shifts is the gate in §7, not the value in §5.
 *
 * The single implementation, so `legalActions` and `reduce` cannot disagree
 * about what is openable.
 */
export function openLevelFor(
  ctx: EngineContext,
  state: Pick<GameState, 'cards' | 'cities' | 'turn' | 'seats'>,
  player: PlayerId,
): number {
  // A Normal Effect may have narrowed the turn for everybody (BK2-010).
  let level = cityLevel(state) + (state.turn.openLevelShift ?? 0);
  for (const source of Object.values(state.cards)) {
    if (source.zone !== 'city' || !source.faceUp) continue;
    for (const ability of abilitiesOf(ctx, source)) {
      if (ability.trigger !== 'always' || ability.effect.do !== 'openLevel') continue;
      // `both` moves the bar for everybody (BK2-056); the others name a side.
      if (ability.effect.player !== 'both') {
        const affected =
          ability.effect.player === 'occupier'
            ? source.cityIndex !== undefined
              ? state.cities[source.cityIndex]?.occupiedBy
              : null
            : state.seats.find((seat) => seat !== source.controller);
        if (affected !== player) continue;
      }
      if (!conditionHolds(ctx, state, source, ability.condition)) continue;
      level += ability.effect.shift;
    }
  }
  // Never below nothing: a Level 0 card is openable whatever is said about it.
  return Math.max(0, level);
}

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
  /**
   * A character about to be sacrificed to an Alteration, which therefore
   * does not conflict: it leaves the field as the new card arrives, and
   * upgrading a Unique you already control is the whole point of the
   * keyword (Rules.md §7, §8).
   */
  leaving?: CardInstanceId | undefined,
): boolean {
  if (!def.unique || !def.name) return false;
  return Object.values(state.cards).some(
    (card) =>
      card.zone === 'city' &&
      card.faceUp &&
      card.instanceId !== leaving &&
      definitionOf(ctx, card).name === def.name,
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
  // An attachment stands where its host stands and goes where its host goes
  // — including the Trash. Rules.md §13: "as long as this card remains in
  // play" is the host's being in play too, because a sword with nobody to
  // hold it is not on the table.
  for (const worn of Object.values(draft.cards)) {
    if (worn.attachedTo === undefined || worn.zone !== 'city') continue;
    const host = draft.cards[worn.attachedTo];
    if (!host || host.zone !== 'city' || !host.faceUp) {
      delete worn.attachedTo;
      moveToZone(draft, worn.instanceId, { player: worn.owner, zone: 'trash' });
      events.push({ type: 'CARD_TRASHED', player: worn.owner, card: worn.instanceId });
      continue;
    }
    if (host.cityIndex !== undefined && worn.cityIndex !== host.cityIndex) {
      const from = worn.cityIndex ?? host.cityIndex;
      worn.cityIndex = host.cityIndex;
      events.push({ type: 'CHARACTER_MOVED', card: worn.instanceId, from, to: host.cityIndex });
    }
  }

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
  // Boosts that do not wear off (BK3-055's "permanently"), kept in counters
  // the End phase does not sweep.
  const permanent =
    stat === 'power'
      ? (card.counters[PERMANENT_POWER] ?? 0)
      : stat === 'hp'
        ? (card.counters[PERMANENT_HP] ?? 0)
        : 0;
  // "While defending" — paid only while its holder is actually in a fight on
  // the defending side (BK1-029). Rules.md §11.
  const rearguard =
    (stat === 'power' || stat === 'hp') &&
    state.battle != null &&
    state.battle.defender === card.controller &&
    state.battle.participants.includes(card.instanceId)
      ? (card.counters[REARGUARD] ?? 0)
      : 0;
  return Math.max(
    0,
    printed + boost + permanent + rearguard + continuousBonus(ctx, state, card, stat),
  );
};

export const powerOf = (ctx: EngineContext, state: BoardView, card: CardInstance): number =>
  statOf(ctx, state, card, 'power');

export const hpOf = (ctx: EngineContext, state: BoardView, card: CardInstance): number =>
  statOf(ctx, state, card, 'hp');

/** How far it can travel in one move. Rules.md §10 ④. */
export const moveOf = (ctx: EngineContext, state: BoardView, card: CardInstance): number =>
  statOf(ctx, state, card, 'move');

/**
 * A character's Range, which sets when it strikes. Rules.md §11 ④. Printed,
 * plus whatever it is wearing: nothing in the set moves Range except an
 * attachment (BK1-076), so there is no counter for it.
 */
export const rangeOf = (
  ctx: EngineContext,
  state: Pick<GameState, 'cards'>,
  card: CardInstance,
): number =>
  Math.max(
    0,
    (definitionOf(ctx, card).stats?.range ?? 0) + attachedBonus(ctx, state, card, 'range'),
  );

/**
 * What the cards attached to this one lend it, for one stat. Rules.md §13.
 *
 * Read off the board like any continuous ability: an attachment in the
 * Trash lends nothing, and `refreshBoard` sends it there the moment its
 * host leaves.
 */
function attachedBonus(
  ctx: EngineContext,
  state: Pick<GameState, 'cards'>,
  card: CardInstance,
  stat: keyof Grants,
): number {
  let total = 0;
  for (const worn of attachmentsOn(ctx, state, card)) {
    for (const ability of abilitiesOf(ctx, worn)) {
      if (ability.effect.do !== 'attach') continue;
      total += ability.effect.grants[stat] ?? 0;
    }
  }
  return total;
}

/** The face-up attachments on the field whose host this card is. */
export const attachmentsOn = (
  ctx: EngineContext,
  state: Pick<GameState, 'cards'>,
  card: CardInstance,
): CardInstance[] =>
  Object.values(state.cards).filter(
    (worn) =>
      worn.attachedTo === card.instanceId &&
      worn.zone === 'city' &&
      worn.faceUp &&
      abilitiesOf(ctx, worn).some((ability) => ability.effect.do === 'attach'),
  );

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
    for (const ability of abilitiesOf(ctx, source)) {
      if (ability.trigger !== 'always' || ability.effect.do !== 'buff') continue;
      const change = ability.effect.stats[stat];
      if (change === undefined) continue;
      if (!selects(ability.effect.who, source, card, (c) => factsOf(ctx, c, state))) continue;
      if (!conditionHolds(ctx, state, source, ability.condition)) continue;
      total += change;
    }
  }
  return total + attachedBonus(ctx, state, card, stat);
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
    for (const ability of abilitiesOf(ctx, source)) {
      if (ability.trigger !== 'always' || ability.effect.do !== 'reduceDamage') continue;
      if (ability.effect.combatOnly === true && !options.combat) continue;
      if (!selects(ability.effect.who, source, card, (c) => factsOf(ctx, c, state))) continue;
      if (!conditionHolds(ctx, state, source, ability.condition)) continue;
      total += ability.effect.amount;
    }
  }
  return Math.max(0, total);
}

/**
 * Is this character holding a ward that will swallow the next blow whole?
 * Rules.md §13 — BK2-024.
 *
 * Asked separately from {@link damageReduction} because a ward is spent
 * rather than subtracted: the caller has to know to take one off the card.
 */
export const hasWard = (card: CardInstance): boolean => (card.counters[WARD] ?? 0) > 0;

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
    for (const ability of abilitiesOf(ctx, source)) {
      if (ability.trigger !== 'always' || ability.effect.do !== 'buff') continue;
      const stats = ability.effect.stats;
      if (!stats.power && !stats.hp && !stats.move) continue;
      if (!selects(ability.effect.who, source, card, (c) => factsOf(ctx, c, state))) continue;
      if (!conditionHolds(ctx, state, source, ability.condition)) continue;
      if (!found.includes(source.instanceId)) found.push(source.instanceId);
      break;
    }
    // Something worn lifts its wearer as surely as an aura does.
    if (source.attachedTo === card.instanceId && attachmentsOn(ctx, state, card).includes(source)) {
      if (!found.includes(source.instanceId)) found.push(source.instanceId);
    }
  }
  return found;
}

/** The printed subtype tokens of a card, e.g. `['hawk', 'leader']`. */
/**
 * Subtypes a card counts as: the printed ones, plus any a card on the board
 * is lending it (BK2-016, "all Mercenaries you control are Hawks in addition
 * to their other types"). Rules.md §3.
 *
 * Read off the board rather than written down, like every other continuous
 * ability, so the grant lapses the moment its source leaves. `state` is
 * optional because a few callers only have a definition to hand; without it
 * this is the printed list, which is the narrower reading.
 */
export const subtypesOf = (
  ctx: EngineContext,
  card: CardInstance,
  state?: Pick<GameState, 'cards'>,
): readonly string[] => {
  const printed = definitionOf(ctx, card).subtypes ?? [];
  if (!state) return printed;
  const granted: string[] = [];
  for (const source of Object.values(state.cards)) {
    if (source.zone !== 'city' || !source.faceUp) continue;
    for (const ability of abilitiesOf(ctx, source)) {
      if (ability.trigger !== 'always' || ability.effect.do !== 'grantSubtype') continue;
      if (printed.includes(ability.effect.subtype)) continue;
      if (granted.includes(ability.effect.subtype)) continue;
      // The selector is read against the printed list, so a grant cannot
      // feed itself a second one.
      const facts: CardFacts = {
        subtypes: printed,
        level: definitionOf(ctx, card).level,
        colour: definitionOf(ctx, card).color,
      };
      if (!selects(ability.effect.who, source, card, () => facts)) continue;
      granted.push(ability.effect.subtype);
    }
  }
  return granted.length > 0 ? [...printed, ...granted] : printed;
};

/** Everything a selector asks about a card, from its printed definition. */
export const factsOf = (
  ctx: EngineContext,
  card: CardInstance,
  state?: Pick<GameState, 'cards'>,
): CardFacts => {
  const def = definitionOf(ctx, card);
  return { subtypes: subtypesOf(ctx, card, state), level: def.level, colour: def.color };
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
    if (card.zone !== 'city') return false;
    if (spec.faceDown === true) {
      // A Set Card, whatever it is — never a standing character, and never
      // the source itself, which is about to be face up.
      if (card.faceUp || card.instanceId === source.instanceId) return false;
    } else if (spec.effectCards !== undefined) {
      // Standing Effect cards, the other face-up population (BK2-014).
      if (!card.faceUp || card.instanceId === source.instanceId) return false;
    } else {
      const standing = card.faceUp || card.instanceId === source.instanceId;
      if (!standing || !isCharacter(ctx, card)) return false;
    }
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
    if (spec.effectCards !== undefined) {
      // Face-up Effect cards rather than characters (BK2-014).
      const def = definitionOf(ctx, card);
      if (def.kind !== 'effect') return false;
      if (spec.effectCards !== 'any' && def.duration !== spec.effectCards) return false;
    }
    if (spec.subtype !== undefined && !subtypesOf(ctx, card, state).includes(spec.subtype))
      return false;
    if (spec.unlocked === true && card.locked) return false;
    // Rules.md §11 ③ — the participants, not merely everyone standing in the
    // contested city. With no battle on, nobody is in combat.
    if (spec.inCombat === true && !battle?.participants.includes(card.instanceId)) return false;
    // §11 — committed *and* on the attacking side, which `inCombat` alone
    // does not distinguish.
    // §11 ① — the character leading the fight running right now.
    if (spec.vanguard === true && battle?.vanguard !== card.instanceId) return false;
    if (spec.unique === true && !definitionOf(ctx, card).unique) return false;
    if (spec.minLevel !== undefined) {
      const level = definitionOf(ctx, card).level;
      if (level === null || level < spec.minLevel) return false;
    }
    // §13 — a card that cannot be chosen by an ability is never offered.
    if (untargetable(ctx, state, card)) return false;
    if (spec.attacking === true) {
      if (!battle?.participants.includes(card.instanceId)) return false;
      if (card.controller !== battle.attacker) return false;
    }
    const def = definitionOf(ctx, card);
    if (spec.colour !== undefined && def.color !== spec.colour) return false;
    if (spec.maxLevel !== undefined && (def.level === null || def.level > spec.maxLevel)) {
      return false;
    }
    return true;
  });
}

/**
 * The cards on the field a selector reaches from `source`. Rules.md §13.
 *
 * One population or the other, never both — `selects` enforces which. A
 * face-down Set Card is whatever it is, so the character test would be wrong
 * to ask; a face-up card must be a *character*, because every effect in the
 * set that reaches across the board reaches characters, and an Eternal
 * standing in the area is not one of them.
 */
export function reachedBy(
  ctx: EngineContext,
  state: BoardView,
  source: CardInstance,
  selector: Selector,
  chosen?: CardInstanceId | undefined,
  /** The second chosen character (BK2-029), for a `target2` selector. */
  chosen2?: CardInstanceId | undefined,
  /**
   * The battle to read `Selector.inCombat` against. Passed rather than taken
   * off the state because `BoardView` deliberately has no battle on it —
   * mirroring `conditionHolds`, and for the same reason.
   */
  battle?: BattleState | null,
): CardInstance[] {
  const scope = selector.scope ?? 'self';
  const aimed = scope === 'target' || scope === 'target2';
  return Object.values(state.cards).filter((card) => {
    if (card.zone !== 'city') return false;
    if (!card.faceUp) {
      // A chosen target is the whole selection: `legalTargets` already said
      // what could be pointed at, and a spec with `faceDown` said Set Cards.
      // Re-filtering by population here would drop exactly those (BK1-031).
      if (!aimed && selector.faceDown !== true) return false;
      // A face-down selector may still narrow by what the card *is*: BK1-142
      // reveals every Set Card the enemy holds and then destroys only the
      // Effect cards among them. Without this the destroy would sweep up the
      // characters it had just turned over.
      if (selector.effectCards !== undefined) {
        const def = definitionOf(ctx, card);
        if (def.kind !== 'effect') return false;
        if (selector.effectCards !== 'any' && def.duration !== selector.effectCards) return false;
      }
    } else if (selector.effectCards !== undefined) {
      // Standing Effect cards, not characters — the other face-up population.
      const def = definitionOf(ctx, card);
      if (def.kind !== 'effect') return false;
      if (selector.effectCards !== 'any' && def.duration !== selector.effectCards) return false;
    } else if (!isCharacter(ctx, card)) {
      return false;
    }
    // §11 ③ — committed to the fight running right now. With no battle on,
    // nothing qualifies, so the effect reaches nobody.
    if (selector.inCombat === true && !battle?.participants.includes(card.instanceId)) {
      return false;
    }
    return selects(selector, source, card, (c) => factsOf(ctx, c, state), chosen, chosen2);
  });
}

/* --------------------------------------------------------- Quick relevance
 *
 * Rules.md §13 lets a Quick interject at any time, and DesignNotes narrows
 * *when* the game stops to ask. This narrows *which* cards it asks about:
 * a window whose only answer is a card that would do nothing — "+2/+2 until
 * end of turn" with no battle on, "deal 3 damage to a character in combat"
 * with nobody in combat — is a click with no decision in it, and asking six
 * times a turn is how a Quick becomes a nuisance rather than a threat.
 */

/**
 * Would this ability be worth using right now, if it were Quick?
 *
 * The judgement is by *kind* of effect, not by card, so it needs no data and
 * cannot drift from the registry:
 *
 * - card advantage — draw, search, discard, return to hand — is worth taking
 *   at any moment, since the window costs nothing but the card's own price;
 * - a continuous ability is a card that will sit on the table doing its
 *   work, and opening it out of turn saves the turn's one open (§10 ③);
 * - anything that lasts "until end of turn" — a buff, a shield, a lock —
 *   is only worth anything while a battle is running to spend it in;
 * - damage matters in a battle, or when it would kill something outright;
 * - destroying or moving a character changes the board whenever it can
 *   reach one.
 *
 * And in every case the effect has to reach *somebody*: Rules.md §13 lets an
 * ability resolve and find nobody, but that is a thing to allow, not a thing
 * to stop the game and offer.
 */
export function quickRelevant(
  ctx: EngineContext,
  state: GameState,
  source: CardInstance,
  ability: Ability,
): boolean {
  // An ability that asks for a target has to have one, or it does nothing.
  if (
    ability.target &&
    legalTargets(ctx, state, source, ability.target, state.battle).length === 0
  ) {
    return false;
  }
  if (!conditionHolds(ctx, state, source, ability.condition, state.battle)) return false;
  if (ability.area !== undefined && areasFor(ctx, state, ability.area, source).length === 0) {
    // Relative to a character it is checked once one is chosen; here only the
    // kinds that stand on their own can be empty.
    if (ability.area !== 'adjacent') return false;
  }

  // A boost or a shield is worth spending inside a battle — or in answer to
  // an effect about to do harm (Rules.md §14): Magical Barrier is for
  // exactly the moment Schierke's damage is pending.
  const inBattle = state.battle !== null || respondingToHarm(ctx, state);
  const effects = [ability.effect, ...(ability.then ?? [])];
  return effects.some((effect) => effectRelevant(ctx, state, source, ability, effect, inBattle));
}

/** Is the window being asked about a pending effect that deals damage or destroys? */
function respondingToHarm(ctx: EngineContext, state: GameState): boolean {
  if (state.quick?.trigger !== 'response') return false;
  const top = state.stack[state.stack.length - 1];
  const source = top ? state.cards[top.source] : undefined;
  const ability = source ? definitionOf(ctx, source).abilities?.[top?.ability ?? -1] : undefined;
  if (!ability) return false;
  return [ability.effect, ...(ability.then ?? [])].some(
    (effect) => effect.do === 'damage' || effect.do === 'destroy',
  );
}

/**
 * Is this Set Card worth offering in a Quick window? Rules.md §13.
 *
 * What opening it does is its on-open abilities, plus any continuous one it
 * will sit there with. A card with neither does nothing at all — the
 * registry has no entry for it — and is not offered, because a window whose
 * only answer is a card that does nothing is not a question.
 */
export function quickCardRelevant(
  ctx: EngineContext,
  state: GameState,
  card: CardInstance,
): boolean {
  return abilitiesOf(ctx, card).some(
    (ability) =>
      (ability.trigger === 'open' || ability.trigger === 'always') &&
      quickRelevant(ctx, state, card, ability),
  );
}

function effectRelevant(
  ctx: EngineContext,
  state: GameState,
  source: CardInstance,
  ability: Ability,
  effect: Effect,
  inBattle: boolean,
): boolean {
  // A chosen target is the whole selection, and `quickRelevant` has already
  // checked one exists — so a `target` selector reaches exactly one card.
  const reaches = (who: Selector): boolean =>
    (who.scope ?? 'self') === 'target'
      ? ability.target !== undefined
      : reachedBy(ctx, state, source, who, undefined, undefined, state.battle).length > 0;

  switch (effect.do) {
    case 'draw':
      // "For each" of nothing draws nothing.
      return (
        effect.per === undefined ||
        reachedBy(ctx, state, source, effect.per, undefined, undefined, state.battle).length > 0
      );
    case 'search':
      return (
        searchable(ctx, state, source.controller, effect.named, effect.characterOnly === true)
          .length > 0
      );
    case 'setFromHand':
      return settable(ctx, state, source.controller, effect.maxLevel).length > 0;
    case 'may':
      return effect.effects.some((inner) =>
        effectRelevant(ctx, state, source, ability, inner, inBattle),
      );
    case 'chooseMode':
      // Either branch being worth taking makes the question worth asking.
      return [...effect.effects, ...effect.orElse].some((inner) =>
        effectRelevant(ctx, state, source, ability, inner, inBattle),
      );
    case 'skipDraw':
      return true;
    case 'attach':
      return reaches(effect.who);
    case 'discard': {
      const player =
        effect.player === 'you'
          ? source.controller
          : state.seats.find((seat) => seat !== source.controller);
      return player !== undefined && (state.zoneOrder[zoneKey(player, 'hand')]?.length ?? 0) > 0;
    }
    case 'returnToHand':
      return reaches(effect.who);
    case 'buff':
      // Continuous, or fighting: a boost that lasts the turn is spent in a
      // battle or not at all. And a scaled boost across nothing is nothing.
      if (ability.trigger !== 'always' && !inBattle) return false;
      if (
        effect.per !== undefined &&
        reachedBy(ctx, state, source, effect.per, undefined, undefined, state.battle).length === 0
      ) {
        return false;
      }
      return reaches(effect.who);
    case 'reorderTop':
      // Knowing and arranging the next few draws is worth doing whenever the
      // deck holds enough for the order to be a choice.
      return true;
    case 'openSetCard':
      // A body onto the board for free — worth doing wherever there is one
      // lying face down to turn up.
      return reaches(effect.who);
    case 'defenderBonus':
      // Only ever pays out inside a battle, so it is only relevant in one.
      return inBattle && reaches(effect.who);
    case 'seal':
      // Denying an open outlasts the moment, so it is worth doing whenever
      // there is a Set Card to shut.
      return reaches(effect.who);
    case 'cannotBattle':
      // Outlasts the turn's fighting rather than a single blow, so it is
      // worth doing whenever there is somebody to bar.
      return reaches(effect.who);
    case 'reduceDamage':
    case 'cannotAttack':
    case 'unlock':
      return (ability.trigger === 'always' || inBattle) && reaches(effect.who);
    case 'damage': {
      const victims =
        (effect.who.scope ?? 'self') === 'target'
          ? ability.target
            ? legalTargets(ctx, state, source, ability.target, state.battle)
            : []
          : reachedBy(ctx, state, source, effect.who, undefined, undefined, state.battle);
      if (victims.length === 0) return false;
      if (inBattle) return true;
      // Outside a battle, damage clears at end of turn (§10 ⑤): it is only
      // worth dealing if it kills.
      return victims.some(
        (card) =>
          card.damage + damageAfterReduction(ctx, state, card, effect.amount, { combat: false }) >=
          hpOf(ctx, state, card),
      );
    }
    case 'destroy':
    case 'moveTo':
      return reaches(effect.who);
    case 'revealUntilCharacter':
      // Card advantage of a sort — a body onto the board — and worth doing
      // whenever the deck still holds a character.
      return true;
    case 'openLevel':
      // Continuous, read off the board by `openLevelFor` when a card is
      // opened. Never resolved.
      return ability.trigger === 'always';
    case 'reveal':
      // Information, which is worth having whenever there is anything hidden
      // left to show.
      return reaches(effect.who);
    case 'lock':
      // Unlike a boost, this outlasts the turn — it is worth doing outside a
      // battle, and against a character that is already locked (BK1-085 is
      // about the *next* Refresh).
      return reaches(effect.who);
    case 'askDestroyOrDiscard':
    case 'destroyOne':
      // Continuations, never printed on a card and never offered on their
      // own — they only ever run from inside a choice already under way.
      return false;
    case 'negate':
      // Silencing outlasts the moment and is worth doing wherever there is
      // something to silence.
      return reaches(effect.who);
    case 'discardDownTo':
      // Card advantage, which §13 counts wherever it happens.
      return true;
    case 'openLevelForTurn':
      // Narrowing what can be opened is worth doing whenever anything could.
      return true;
    case 'wardNextDamage':
      return reaches(effect.who);
    case 'grantSubtype':
      return ability.trigger === 'always';
    case 'openedCardsLock':
      // Continuous, read off the board where a card is opened.
      return ability.trigger === 'always';
    case 'seeCapital':
      // Knowing where the capital is bears on §1's whole win condition, so
      // it is worth having whenever it is still hidden from you.
      return true;
    case 'mark':
    case 'markedCannotAttackHere':
    case 'markedDiesIfItLeaves':
      // Pinning an enemy down is worth doing wherever there is one to pin.
      return ability.target !== undefined;
    case 'reflectDamage':
      // Only bites inside a fight, where blows are actually struck.
      return inBattle && reaches(effect.who);
    case 'setTopOfDeck':
      // A card onto the board for free, whenever the deck still has one.
      return true;
    case 'buffPermanent':
      // Outlasts the turn, so unlike a boost it is worth doing anywhere.
      return reaches(effect.who);
    case 'setCard':
      return reaches(effect.who);
    case 'untargetable':
      return ability.trigger === 'always';
    case 'ifNotOccupied':
      return effect.effects.some((inner) =>
        effectRelevant(ctx, state, source, ability, inner, inBattle),
      );
    case 'setSelf':
      // Going back face down is a real move: it dodges what is coming, and
      // the card can be opened again later (§7).
      return true;
    case 'clearOccupation':
      return state.cities.some((city) => city.occupiedBy != null);
    case 'pickAndDestroy':
    case 'pickAndLock':
      return reaches(effect.who);
    case 'addCharges':
      // Ammunition for later, worth putting on whenever it is printed.
      return true;
    case 'recycleTrash':
      // Card advantage, and deck repair — worth doing wherever it happens.
      return true;
    case 'removeFromCombat':
      // Only means anything inside a fight, and only reaches participants.
      return inBattle && reaches(effect.who);
    case 'theyPay':
      // Card advantage taken off the other player, worth doing anywhere.
      return true;
    case 'gatherHere':
      // Bodies onto a contested area, which is worth doing wherever there is
      // somebody to bring.
      return reaches(effect.who);
    case 'theyDestroy':
    case 'destroyOrDiscard':
      // Card advantage either way — §13 counts it wherever it happens.
      return reaches(effect.who);
    case 'captureDraw':
      // Continuous, read off the board when a city changes hands.
      return ability.trigger === 'always';
    case 'mill': {
      // is the only way it does nothing. // Card advantage, which §13 counts wherever it happens; an empty deck
      const player =
        effect.player === 'you'
          ? source.controller
          : state.seats.find((seat) => seat !== source.controller);
      return player !== undefined && (state.zoneOrder[zoneKey(player, 'deck')]?.length ?? 0) > 0;
    }
  }
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
  abilitiesOf(ctx, card)
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
/**
 * §12 — a fresh occupation draws two, by the City card's own effect.
 */
export const CAPTURE_DRAW = 2;

/**
 * How many cards §12's capture pays the attacker — normally 2.
 *
 * BK1-093 is a card saying the draw is smaller than the rule allows, so the
 * lowest such number among the attacker's participants wins. Read off the
 * board at the moment of capture rather than stored, so a Troll that died in
 * the fight no longer counts: `stillFighting` is what "attacking with this
 * card" means once the blows have landed (§12).
 */
export function captureDrawFor(ctx: EngineContext, state: GameState, battle: BattleState): number {
  let count = CAPTURE_DRAW;
  // Two populations say what a capture pays: the attackers who took it
  // (BK1-093 draws less), and whatever is standing in the city itself
  // (BK1-145 pays more, and belongs to nobody). A card that says the draw is
  // *smaller* than the rule allows always wins, whichever it is — the
  // narrower number is the one the printed line insists on.
  const speakers = [
    ...stillFighting(state, battle, battle.attacker),
    ...Object.values(state.cards).filter(
      (card) => card.zone === 'city' && card.cityIndex === battle.city && card.faceUp,
    ),
  ];
  const raises: number[] = [];
  for (const card of speakers) {
    for (const ability of abilitiesOf(ctx, card)) {
      if (ability.trigger !== 'always') continue;
      if (ability.effect.do !== 'captureDraw') continue;
      if (!conditionHolds(ctx, state, card, ability.condition, battle)) continue;
      if (ability.effect.count < CAPTURE_DRAW) count = Math.min(count, ability.effect.count);
      else raises.push(ability.effect.count);
    }
  }
  // A raise only applies while nothing has cut the draw down.
  if (count === CAPTURE_DRAW && raises.length > 0) count = Math.max(...raises);
  return count;
}

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
  // Modes of one printed ability share a single use (BK2-021), so spending
  // either shuts both.
  const group = entry.ability.cost?.oncePerTurnGroup;
  if (group !== undefined && (card.counters[`usedOnTurn:${group}`] ?? 0) === turnOrdinal(state)) {
    return false;
  }
  if (entry.ability.cost?.lockSelf === true && card.locked) return false;
  // Too few counters on the card is a price that cannot be paid (BK2-023).
  if (
    entry.ability.cost?.spendCharges !== undefined &&
    (card.counters[CHARGES] ?? 0) < entry.ability.cost.spendCharges
  ) {
    return false;
  }
  // "Destroy this card:" is paid when the ability resolves, not when it is
  // used, or §14's stack would fizzle it as a source that has gone. So the
  // card has to be barred here instead: without this it could be sacrificed
  // again and again while the first use is still pending.
  if (
    entry.ability.cost?.destroySelf === true &&
    state.stack.some((e) => e.source === card.instanceId)
  ) {
    return false;
  }
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
  // Nobody to spend means the price cannot be paid, so it is never offered.
  if (
    entry.ability.cost?.destroyAlly &&
    legalTargets(ctx, state, card, entry.ability.cost.destroyAlly, state.battle).length === 0
  ) {
    return false;
  }

  // A Quick ability rides the same windows a Quick card does: `state.quick`
  // is where an interrupt lives, and DesignNotes "When to offer a Quick" says
  // when one opens. Anything looser would let a Quick ability be used at
  // moments the engine never offers, and `legalActions` would stop matching
  // what `reduce` accepts.
  if (state.quick !== null) {
    return (
      entry.ability.quick === true &&
      state.quick.waitingOn === player &&
      // A window offers what is worth using now, and `reduce` must agree
      // with `legalActions` about it — see `quickRelevant`.
      quickRelevant(ctx, state, card, entry.ability)
    );
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
  abilitiesOf(ctx, card).filter(
    (ability): ability is TargetingAbility =>
      ability.trigger === trigger && ability.target !== undefined,
  );

/**
 * Is this card forbidden from attacking? Rules.md §11.
 *
 * Asked of continuous abilities only, because a restriction has to hold for
 * as long as it is printed rather than being applied once.
 */
/**
 * Is this card barred from the battle entirely? Rules.md §11.
 *
 * Broader than {@link cannotAttack}, and deliberately separate: "cannot
 * participate in battle" (BK1-035, BK1-037, BK1-149) means it cannot be
 * *chosen* for one at all — not as vanguard, not committed by the attacker,
 * not committed by the defender. A character merely forbidden to attack may
 * still stand and defend, which is why the two cannot share a flag.
 *
 * Written onto the card for the turn rather than read off a source, because
 * the cards that impose it are Normal Effects that go to the Trash the
 * moment they resolve (§3) — there would be nothing left on the board to ask.
 */
export function cannotBattle(state: Pick<GameState, 'cards'>, card: CardInstance): boolean {
  return (card.counters[NO_BATTLE] ?? 0) > 0;
}

/**
 * Is this card barred from attacking one particular city? Rules.md §11.
 *
 * Narrower than {@link cannotAttack}, which is about attacking at all:
 * BK1-157 pins one enemy out of one area and leaves it free everywhere
 * else. Read off the board — the Eternal doing the pinning is standing
 * there, and remembers whom it named in `CardInstance.marked`.
 */
export function cannotAttackArea(
  ctx: EngineContext,
  state: BoardView,
  card: CardInstance,
  cityIndex: number,
): boolean {
  for (const source of Object.values(state.cards)) {
    if (source.zone !== 'city' || !source.faceUp) continue;
    if (source.marked !== card.instanceId) continue;
    // "Cannot attack *this area*" — the one the watching card stands in.
    if (source.cityIndex !== cityIndex) continue;
    for (const ability of abilitiesOf(ctx, source)) {
      if (ability.trigger !== 'always') continue;
      if (ability.effect.do !== 'markedCannotAttackHere') continue;
      if (!conditionHolds(ctx, state, source, ability.condition)) continue;
      return true;
    }
  }
  return false;
}

/**
 * Would moving out of its area destroy this character? Rules.md §13.
 *
 * BK1-157's second clause. Read the same way as the first, off the card
 * that named it.
 */
export function diesIfItLeaves(ctx: EngineContext, state: BoardView, card: CardInstance): boolean {
  for (const source of Object.values(state.cards)) {
    if (source.zone !== 'city' || !source.faceUp) continue;
    if (source.marked !== card.instanceId) continue;
    // "If that character is in this area" — the clause only bites while the
    // two are standing together.
    if (source.cityIndex !== card.cityIndex) continue;
    for (const ability of abilitiesOf(ctx, source)) {
      if (ability.trigger !== 'always') continue;
      if (ability.effect.do !== 'markedDiesIfItLeaves') continue;
      if (!conditionHolds(ctx, state, source, ability.condition)) continue;
      return true;
    }
  }
  return false;
}

export function cannotAttack(ctx: EngineContext, state: BoardView, card: CardInstance): boolean {
  for (const source of Object.values(state.cards)) {
    if (source.zone !== 'city' || !source.faceUp) continue;
    for (const ability of abilitiesOf(ctx, source)) {
      if (ability.trigger !== 'always' || ability.effect.do !== 'cannotAttack') continue;
      if (!selects(ability.effect.who, source, card, (c) => factsOf(ctx, c, state))) continue;
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
  /** The card the ability was pointed at, for a condition that asks about it. */
  chosen?: CardInstanceId | undefined,
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
    case 'youCapturedThisArea':
      return (
        source.cityIndex !== undefined &&
        state.turn.activePlayer === source.controller &&
        state.turn.capturedCities.includes(source.cityIndex)
      );
    case 'battleDeclaredThisArea':
      return source.cityIndex !== undefined && state.turn.declaredCities.includes(source.cityIndex);
    case 'noEnemyArrivedThisArea':
      return !state.turn.arrivals.some(
        (arrival) => arrival.city === source.cityIndex && arrival.player !== source.controller,
      );
    case 'enemyArrivedThisArea':
      return state.turn.arrivals.some(
        (arrival) => arrival.city === source.cityIndex && arrival.player !== source.controller,
      );
    case 'defendedThisArea':
      // §11 ① — a battle was declared here, and by the other player, which is
      // the only way its controller can have been the one defending.
      return (
        source.cityIndex !== undefined &&
        state.turn.declaredCities.includes(source.cityIndex) &&
        state.turn.activePlayer !== source.controller
      );
    case 'areaUnoccupied':
      return source.cityIndex !== undefined && cityOf(state, source)?.occupiedBy == null;
    case 'enemyLevelHere':
      return Object.values(state.cards).some((card) => {
        if (card.zone !== 'city' || !card.faceUp) return false;
        if (card.cityIndex !== source.cityIndex) return false;
        if (card.controller === source.controller) return false;
        const level = definitionOf(ctx, card).level;
        return level !== null && level >= condition.level;
      });
    case 'openedCharacterHere':
      return Object.values(state.cards).some(
        (card) =>
          card.zone === 'city' &&
          card.faceUp &&
          card.cityIndex === source.cityIndex &&
          card.controller === source.controller &&
          isCharacter(ctx, card) &&
          (card.counters[OPENED_ON_TURN] ?? 0) === turnOrdinal(state),
      );
    case 'targetDoesNotOccupyThisArea': {
      // Needs the card the ability was pointed at, which only an arrival or a
      // chosen target supplies; with nobody named there is nothing to judge.
      if (!chosen) return false;
      const newcomer = state.cards[chosen];
      if (!newcomer || newcomer.cityIndex === undefined) return false;
      return state.cities[newcomer.cityIndex]?.occupiedBy !== newcomer.controller;
    }
    case 'allyArrivedThisArea':
      return state.turn.arrivals.some(
        (arrival) => arrival.city === source.cityIndex && arrival.player === source.controller,
      );
    case 'losingBadly': {
      const mine = state.cities.filter((city) => city.occupiedBy === source.controller).length;
      const theirs = state.cities.filter(
        (city) => city.occupiedBy != null && city.occupiedBy !== source.controller,
      ).length;
      return mine === 0 && theirs >= condition.enemyAtLeast;
    }
    case 'aloneHere':
      return !Object.values(state.cards).some(
        (card) =>
          card.zone === 'city' &&
          card.faceUp &&
          card.cityIndex === source.cityIndex &&
          card.controller === source.controller &&
          card.instanceId !== source.instanceId &&
          isCharacter(ctx, card),
      );
    case 'selfUnlocked':
      return !source.locked;
    case 'enemyDoesNotOccupyThisArea': {
      const holder = cityOf(state, source)?.occupiedBy;
      return holder == null || holder === source.controller;
    }
    case 'openedByAlteration':
      return (source.counters[ALTERED] ?? 0) > 0;
    case 'openedNormally':
      return (source.counters[ALTERED] ?? 0) === 0;
    case 'targetIsAlly': {
      if (!chosen) return false;
      const newcomer = state.cards[chosen];
      return (
        newcomer !== undefined &&
        newcomer.controller === source.controller &&
        newcomer.instanceId !== source.instanceId
      );
    }
    case 'inBattleHere':
      return battle != null && battle.city === source.cityIndex;
    case 'outnumberedHere': {
      const here = (owner: PlayerId): number =>
        Object.values(state.cards).filter(
          (card) =>
            card.zone === 'city' &&
            card.faceUp &&
            card.cityIndex === source.cityIndex &&
            card.controller === owner &&
            isCharacter(ctx, card),
        ).length;
      const them = state.seats.find((seat) => seat !== source.controller);
      return them !== undefined && here(them) > here(source.controller);
    }
    case 'notInCapital':
      return source.cityIndex !== undefined && !state.cities[source.cityIndex]?.royalCapital;
    case 'enemyHasNothingHere':
      // "A card (set or open)" — face down counts, so this looks at every
      // card of theirs standing in the area, whatever it is.
      return !Object.values(state.cards).some(
        (card) =>
          card.zone === 'city' &&
          card.cityIndex === source.cityIndex &&
          card.controller !== source.controller,
      );
    case 'cityLevelAtMost':
      // "Area level" reads as City Level: §5 defines one global value.
      return cityLevel(state) <= condition.level;
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

  const top = Math.max(...alive.map((card) => rangeOf(ctx, state, card)));
  const band = alive.filter((card) => rangeOf(ctx, state, card) === top);
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
/**
 * A player's characters still in the fight. Rules.md §12.
 *
 * "Remain in the battle" is three things, and dropping any of them has been a
 * bug: still a *participant* (§12 counts only who was committed, never the
 * bystanders), still on the field rather than in the Trash, and **still in the
 * contested area**. That last one is easy to miss, because destruction is the
 * usual way to leave a battle — but a card effect can move a character out
 * (§13, §14 lets an effect override the rule it contradicts), and a character
 * standing one area away is not fighting here whatever it agreed to earlier.
 *
 * The single implementation, because `battleResult`, the damage step's "is
 * there anyone left to strike" and its "who may be hit" all have to agree. They
 * disagreed once and a moved character kept fighting from the next city.
 */
export function stillFighting(
  state: Pick<GameState, 'cards'>,
  battle: BattleState,
  player: PlayerId,
): CardInstance[] {
  return battle.participants
    .map((id) => state.cards[id])
    .filter(
      (card): card is CardInstance =>
        card !== undefined &&
        card.zone === 'city' &&
        card.cityIndex === battle.city &&
        card.controller === player,
    );
}

export function battleResult(
  ctx: EngineContext,
  state: Pick<GameState, 'cards'>,
  battle: BattleState,
): BattleResult {
  const attackers = stillFighting(state, battle, battle.attacker).length;
  const defenders = stillFighting(state, battle, battle.defender).length;

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
    (card) =>
      !card.locked &&
      !cannotBattle(state, card) &&
      !cannotAttack(ctx, state, card) &&
      // Pinned out of this one city, but free to lead elsewhere (BK1-157).
      !cannotAttackArea(ctx, state, card, cityIndex),
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
      // "Cannot participate in battle" bars it from either side of the fight.
      !cannotBattle(state, card) &&
      // A character forbidden only to *attack* may still defend: that
      // restriction is on attacking, and the defender is not. Rules.md §11.
      !(player === battle.attacker && cannotAttack(ctx, state, card)) &&
      !(player === battle.attacker && cannotAttackArea(ctx, state, card, battle.city)),
  );
}

/**
 * The cards in a player's deck a search may legally take. Rules.md §13.
 *
 * Lives here rather than beside the effect that uses it because three callers
 * have to agree on it: the reducer validating a pick, `legalActions` offering
 * them, and `view.ts` deciding which deck cards to reveal. A deck is hidden
 * from everyone, so a client offered a card the view had redacted would see a
 * hole in its own deck, and one shown a card the reducer would refuse would
 * learn something about the order it is about to have shuffled away. One list,
 * one place.
 */
export function searchable(
  ctx: EngineContext,
  state: GameState,
  player: PlayerId,
  named: string | null,
  characterOnly = false,
  /** Look in the Trash too (BK1-115). Rules.md §14 — it is public anyway. */
  includeTrash = false,
  /**
   * Only the top this-many cards of the deck are in reach (BK1-023, "look at
   * the top 5"). Rules.md §13.
   *
   * The whole point of the limit is secrecy: `view.ts` reveals exactly what
   * this returns, so a search that looked deeper than the card allows would
   * show the player the rest of their deck. Undefined is the ordinary
   * unlimited search.
   */
  topOfDeck?: number,
): CardInstance[] {
  const wholeDeck = state.zoneOrder[zoneKey(player, 'deck')] ?? [];
  const deck = [
    ...(topOfDeck === undefined ? wholeDeck : wholeDeck.slice(0, topOfDeck)),
    // A "top of deck" look never reaches the Trash: the two are different
    // instructions and no card in the set asks for both.
    ...(includeTrash && topOfDeck === undefined
      ? (state.zoneOrder[zoneKey(player, 'trash')] ?? [])
      : []),
  ];
  return (
    deck
      .map((id) => state.cards[id])
      .filter((card): card is CardInstance => card !== undefined)
      // By printed name, not by card id: "1 Serpico" does not care which
      // printing of Serpico the deck happens to be holding.
      .filter((card) => named === null || definitionOf(ctx, card).name === named)
      .filter((card) => !characterOnly || isCharacter(ctx, card))
  );
}

/**
 * The areas an ability may send somebody to. Rules.md §13, `AreaKind`.
 *
 * The single implementation, so `legalActions` and `reduce` cannot disagree
 * about what "adjacent" or "any other area" means. `target` is the chosen
 * character, for a kind that is relative to one.
 */
export function areasFor(
  ctx: EngineContext,
  state: BoardView,
  kind: AreaKind,
  source: CardInstance,
  target?: CardInstanceId,
): number[] {
  const all = state.cities.map((city) => city.index);
  switch (kind) {
    case 'adjacent': {
      const from = target === undefined ? undefined : state.cards[target]?.cityIndex;
      if (from === undefined) return [];
      return [from - 1, from + 1].filter((index) => index >= 0 && index < state.cities.length);
    }
    case 'anyOther':
      return all.filter((index) => index !== source.cityIndex);
    case 'withinOne':
      // §15, counted from the card's own area — which is included, since
      // "the same area within 1 distance" may well be where it stands.
      return all.filter(
        (index) => source.cityIndex !== undefined && cityDistance(source.cityIndex, index) <= 1,
      );
    case 'withinTwo':
      // §15 Distance, from the card's own area — "another area", so not this.
      return all.filter(
        (index) =>
          source.cityIndex !== undefined &&
          index !== source.cityIndex &&
          cityDistance(source.cityIndex, index) <= 2,
      );
    case 'youOccupyOther':
      // §12 — "any other area you occupy", so the card's own city is out.
      return all.filter(
        (index) =>
          index !== source.cityIndex && state.cities[index]?.occupiedBy === source.controller,
      );
    case 'enemyLevel3':
      return all.filter(
        (index) =>
          index !== state.cards[target ?? '']?.cityIndex &&
          Object.values(state.cards).some(
            (card) =>
              card.zone === 'city' &&
              card.cityIndex === index &&
              card.faceUp &&
              card.controller !== source.controller &&
              isCharacter(ctx, card) &&
              (definitionOf(ctx, card).level ?? 0) >= 3,
          ),
      );
  }
}

/** The abilities on a card that ask the player to choose something, in order. */
export const askingAbilities = (
  ctx: EngineContext,
  card: CardInstance,
  trigger: Trigger,
): Ability[] =>
  abilitiesOf(ctx, card).filter(
    (ability) =>
      ability.trigger === trigger && (ability.target !== undefined || ability.area !== undefined),
  );

/** The cards in hand a "set from hand" choice may take. Rules.md §13. */
export function settable(
  ctx: EngineContext,
  state: GameState,
  player: PlayerId,
  maxLevel: number | null,
): CardInstance[] {
  return (state.zoneOrder[zoneKey(player, 'hand')] ?? [])
    .map((id) => state.cards[id])
    .filter((card): card is CardInstance => card !== undefined && isCharacter(ctx, card))
    .filter((card) => {
      const level = definitionOf(ctx, card).level;
      return level !== null && (maxLevel === null || level <= maxLevel);
    });
}
