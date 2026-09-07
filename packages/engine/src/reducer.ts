import {
  abilityKey,
  counterFor,
  selects,
  BOOST_COUNTERS,
  NEGATED,
  NO_BATTLE,
  REARGUARD,
  REFLECT,
  SEALED,
  SHIELD,
  SKIP_REFRESH,
  WARD,
  targetPlayer,
  usedOnTurnCounter,
  type Ability,
  type Effect,
  type Selector,
  type StatLine,
  type Trigger,
} from './abilities.js';
import { toDraft, type Draft } from './draft.js';
import { nextInt, shuffle, type Rng } from './rng.js';
import { legalActions, quickOpens } from './legal.js';
import type { CardInstanceId, PlayerId } from './ids.js';
import { ok, violation, type Result, type RuleViolation } from './result.js';
import {
  activatedAbilities,
  activationCost,
  areasFor,
  askingAbilities,
  abilitiesOf,
  battleResult,
  captureDrawFor,
  canActivate,
  canCommit,
  canVanguard,
  checkWinConditions,
  cityLevel,
  openLevelFor,
  opensLocked,
  conditionHolds,
  damageAfterReduction,
  hasWard,
  definitionOf,
  hpOf,
  isCharacter,
  moveOf,
  nextRangeBand,
  powerOf,
  cannotBattle,
  diesIfItLeaves,
  presenceIn,
  quickCardRelevant,
  reachedBy,
  refreshBoard,
  searchable,
  stillFighting,
  legalTargets,
  settable,
  turnOrdinal,
  OPENED_ON_TURN,
  uniqueConflict,
  validatePayment,
  HAND_LIMIT,
  type EngineContext,
} from './rules.js';
import { bottomCard, drawCards, mulligan, MIN_KEPT_HAND, STARTING_HAND_SIZE } from './setup.js';
import type {
  BattleState,
  BattleStep,
  CardInstance,
  Continuation,
  GameAction,
  GameEvent,
  GameState,
  PendingChoice,
  PendingEffect,
  PhaseDef,
  QuickResume,
  QuickTrigger,
  QuickWindow,
} from './types.js';
import { cardsInZone, cityDistance, moveToCity, moveToZone, zoneKey } from './zones.js';

/**
 * The single entry point for changing game state.
 *
 * `reduce(ctx, state, actor, action)` is pure: same inputs, same outputs, no
 * I/O, no clock, no `Math.random()`. Everything else in the system — server,
 * client, AI, tests, replays — is built on that guarantee. If you find
 * yourself wanting to read the time or hit a database in here, the value
 * belongs in the action payload instead.
 *
 * Section references in comments point at Rules.md.
 */

export interface ReduceOutput {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
}

export type ReduceResult = Result<ReduceOutput, RuleViolation>;

/** Actions that belong to a running battle, and so answer to it rather than to priority. */
function isBattleAction(action: GameAction): boolean {
  switch (action.type) {
    case 'DESIGNATE_VANGUARD':
    case 'COMMIT_CHARACTER':
    case 'BATTLE_PASS':
    case 'ASSIGN_DAMAGE':
    // §11 ② — the defender's combat open happens on the attacker's turn.
    case 'OPEN_CARD':
      return true;
    default:
      return false;
  }
}

export function reduce(
  ctx: EngineContext,
  state: GameState,
  actor: PlayerId,
  action: GameAction,
): ReduceResult {
  if (state.status.kind === 'finished') {
    return violation('GAME_OVER', 'The match has already ended.');
  }
  if (!state.players[actor]) {
    return violation('NOT_YOUR_TURN', `${actor} is not a player in this match.`);
  }

  const draft = toDraft(state);
  const events: GameEvent[] = [];

  // Mulligans happen before the first turn, and both players decide
  // independently, so priority does not apply yet. Rules.md §9.4.
  if (state.status.kind === 'setup') {
    const result = reduceSetup(ctx, draft, actor, action, events);
    if (!result.ok) return result;
    return finish(state, draft, events);
  }

  // An effect that stopped to ask outranks everything, including a Quick
  // window and a running battle: it is not a window the player may decline but
  // an effect that is already half-resolved, and nothing else can happen until
  // it finishes. Rules.md §13. Conceding is still allowed, because a player
  // must never be trapped in a match by a prompt.
  if (state.pending && action.type !== 'CONCEDE') {
    if (actor !== state.pending.waitingOn) {
      return violation('NOT_YOUR_PRIORITY', 'Waiting on your opponent to choose.', '§13');
    }
    if (action.type !== 'CHOOSE_CARD' && action.type !== 'ANSWER') {
      return violation('WRONG_PHASE', 'Answer the card you are being asked for first.', '§13');
    }
  }

  // A Quick window is an interrupt: while one is open the game is stopped and
  // only the player being asked may act, whoever's turn it is. Rules.md §13.
  if (state.quick && action.type !== 'CONCEDE') {
    if (actor !== state.quick.waitingOn) {
      return violation('NOT_YOUR_PRIORITY', 'Waiting on your opponent to answer.', '§13');
    }
    if (
      action.type !== 'OPEN_CARD' &&
      action.type !== 'USE_ABILITY' &&
      action.type !== 'PASS_PRIORITY'
    ) {
      return violation(
        'WRONG_PHASE',
        'You may open a Quick card, use a Quick ability, or pass.',
        '§13',
      );
    }
  }

  // A battle overrides priority: it runs its own steps and each waits on a
  // named player, which for most of them is the *defender* — and it is not
  // their turn. Rules.md §11 has the defender opening, committing and
  // assigning damage throughout the attacker's Main phase.
  const inBattle = state.battle !== null && isBattleAction(action);

  // Conceding is always legal, including out of turn. So is reaching for an
  // ability: a Quick one may be used at any time (§13), and `canActivate` is
  // the single authority on when — it holds everything else to its
  // controller's own Main phase, which this gate could only duplicate.
  //
  // So is answering a question the game has stopped to ask. The gate above has
  // already checked it is the right player's answer, and it is routinely *not*
  // their turn: a defender's combat open (§11 ②) can be the very card that
  // asked, and holding the answer to priority would freeze the match on a
  // prompt nobody was allowed to reply to.
  if (
    action.type !== 'CONCEDE' &&
    action.type !== 'USE_ABILITY' &&
    action.type !== 'CHOOSE_CARD' &&
    action.type !== 'ANSWER' &&
    !inBattle &&
    state.quick === null &&
    state.turn.priorityPlayer !== actor
  ) {
    return violation('NOT_YOUR_PRIORITY', 'You do not have priority right now.');
  }

  const result = applyAction(ctx, draft, actor, action, events);
  if (!result.ok) return result;

  refreshBoard(ctx, draft, events);
  checkWinConditions(draft, events);

  // An action can be the last thing a phase had to offer — the turn's one open
  // (§10 ③), or the last card out of a hand. Settling here as well as on entry
  // means the player is never left holding a "next phase" button that is the
  // only thing on the table.
  settle(ctx, draft, events);

  return finish(state, draft, events);
}

function finish(previous: GameState, draft: Draft<GameState>, events: GameEvent[]): ReduceResult {
  draft.version = previous.version + 1;
  // Events are immutable values; the draft's log is the mutable mirror of the
  // same shape, so the cast is safe and confined to this line.
  draft.log.push(...(events as Draft<GameEvent>[]));
  return ok({ state: draft as GameState, events });
}

/* ------------------------------------------------------------------- setup */

function reduceSetup(
  ctx: EngineContext,
  draft: Draft<GameState>,
  actor: PlayerId,
  action: GameAction,
  events: GameEvent[],
): Result<true, RuleViolation> {
  if (!draft.mulliganPending.includes(actor)) {
    return violation('ALREADY_ACTED', 'You have already kept your opening hand.', '§9');
  }

  const owedBottoms = draft.pendingBottom[actor] ?? 0;

  /** Settle this seat, and start the match once both have settled. */
  const settle = (): void => {
    draft.mulliganPending = draft.mulliganPending.filter((id) => id !== actor);
    if (draft.mulliganPending.length === 0) {
      draft.status = { kind: 'playing' };
      beginTurn(ctx, draft, draft.turn.activePlayer, events, { firstTurn: true });
    }
  };

  switch (action.type) {
    case 'MULLIGAN': {
      if (owedBottoms > 0) {
        return violation('ALREADY_ACTED', 'Finish bottoming cards first.', 'DesignNotes 5');
      }
      if ((draft.handTarget[actor] ?? 0) <= MIN_KEPT_HAND) {
        return violation('ALREADY_ACTED', 'You must keep at least one card.', 'DesignNotes 5');
      }
      // `mulligan` works on immutable state; splice the result back in.
      const next = mulligan(draft as GameState, actor);
      spliceState(draft, next, events);
      return ok(true);
    }

    case 'BOTTOM_CARD': {
      if (owedBottoms <= 0) {
        return violation('ALREADY_ACTED', 'You have no cards left to bottom.', 'DesignNotes 5');
      }
      const card = draft.cards[action.card];
      if (!card || card.zone !== 'hand' || card.controller !== actor) {
        return violation('CARD_NOT_IN_ZONE', 'That card is not in your hand.', 'DesignNotes 5');
      }
      spliceState(draft, bottomCard(draft as GameState, actor, action.card), events);
      // Bottoming is the last thing a keep is waiting on.
      if ((draft.pendingBottom[actor] ?? 0) === 0) settle();
      return ok(true);
    }

    case 'KEEP_HAND': {
      if (owedBottoms > 0) {
        return violation('ALREADY_ACTED', 'Finish bottoming cards first.', 'DesignNotes 5');
      }
      // The decision comes first and the cost after: a player who has
      // mulliganed now pays for the hand they have chosen to keep, rather
      // than paying for one they may be about to throw away.
      const owed = handSize(draft, actor) - (draft.handTarget[actor] ?? STARTING_HAND_SIZE);
      if (owed > 0) {
        draft.pendingBottom = toDraft({ ...draft.pendingBottom, [actor]: owed });
        return ok(true);
      }
      settle();
      return ok(true);
    }

    case 'CONCEDE':
      concede(draft, actor, events);
      return ok(true);

    default:
      return violation(
        'WRONG_PHASE',
        'Only mulligan decisions are legal before the match begins.',
        '§9',
      );
  }
}

/**
 * Copies the result of an immutable setup helper back into the draft and
 * forwards whatever it appended to the log as events.
 */
function spliceState(draft: Draft<GameState>, next: GameState, events: GameEvent[]): void {
  events.push(...next.log.slice(draft.log.length));
  draft.cards = toDraft(next.cards);
  draft.zoneOrder = toDraft(next.zoneOrder);
  draft.pendingBottom = toDraft(next.pendingBottom);
  draft.handTarget = toDraft(next.handTarget);
  draft.rng = toDraft(next.rng);
}

/* ----------------------------------------------------------------- actions */

function applyAction(
  ctx: EngineContext,
  draft: Draft<GameState>,
  actor: PlayerId,
  action: GameAction,
  events: GameEvent[],
): Result<true, RuleViolation> {
  const phase = currentPhase(draft);

  switch (action.type) {
    case 'CONCEDE':
      concede(draft, actor, events);
      return ok(true);

    case 'END_PHASE':
      return endPhase(ctx, draft, actor, events);

    case 'SET_CARD':
      return setCard(draft, actor, action.card, action.city, events);

    case 'OPEN_CARD':
      return settled(
        ctx,
        draft,
        events,
        openCard(
          ctx,
          draft,
          actor,
          action.card,
          action.pay,
          action.targets ?? [],
          action.areas ?? [],
          events,
        ),
      );

    case 'MOVE_CHARACTER':
      return moveCharacter(ctx, draft, actor, action.card, action.city, events);

    case 'DISCARD_CARD':
      return discardCard(draft, actor, action.card, events);

    // Answering suspends nothing further, but it may be the last thing a
    // battle step was waiting behind — a combat open (§11 ②) whose card asked
    // a question froze the battle until now, so it settles like any other
    // action that could have moved one on.
    case 'CHOOSE_CARD':
      return settled(
        ctx,
        draft,
        events,
        chooseCard(ctx, draft, actor, action.card, events, action.city),
      );

    case 'ANSWER':
      return settled(ctx, draft, events, answer(ctx, draft, actor, action.accept, events));

    case 'MULLIGAN':
    case 'BOTTOM_CARD':
    case 'KEEP_HAND':
      return violation('WRONG_PHASE', 'The opening hand has already been settled.', '§9');

    case 'DECLARE_BATTLE':
      return settled(ctx, draft, events, declareBattle(ctx, draft, actor, action.city, events));

    case 'DESIGNATE_VANGUARD':
      return settled(ctx, draft, events, designateVanguard(ctx, draft, actor, action.card, events));

    case 'COMMIT_CHARACTER':
      return settled(ctx, draft, events, commitCharacter(ctx, draft, actor, action.card, events));

    case 'BATTLE_PASS':
      return settled(ctx, draft, events, battlePass(ctx, draft, actor, events));

    case 'ASSIGN_DAMAGE':
      return settled(
        ctx,
        draft,
        events,
        assignDamage(ctx, draft, actor, action.card, action.hits, events),
      );

    // RULES: abilities (§13) and the pending-resolution stack (§14) are still
    // to build. Each must validate legality itself — never trust that the
    // client only offers legal moves.
    case 'PASS_PRIORITY': {
      // Declining a Quick window. Rules.md §13. Outside one there is nothing
      // to pass on yet — that is the §14 stack, which is not built.
      if (!draft.quick) {
        return violation('WRONG_PHASE', 'Nothing is waiting on you.', '§14');
      }
      events.push({ type: 'QUICK_DECLINED', player: actor });
      const { trigger, then: next } = draft.quick;
      draft.quick = null;
      // Rules.md §13 — the turn player was asked first; now the other one.
      if (next !== undefined) offerQuickTo(ctx, draft, next, trigger, events);
      // Rules.md §14 — both passed on the pending effect: it resolves, and
      // whatever is left on the stack gets its own round.
      if (!draft.quick && trigger === 'response') {
        resolveTop(ctx, draft, events);
        startRound(ctx, draft, events, draft.resume);
      }
      // Play was frozen where the window opened; let it carry on.
      settleBattle(ctx, draft, events);
      settle(ctx, draft, events);
      return ok(true);
    }

    case 'USE_ABILITY':
      return settled(ctx, draft, events, useAbility(ctx, draft, actor, action, events));

    default: {
      const exhaustive: never = action;
      throw new Error(`Unhandled action: ${JSON.stringify(exhaustive)} in phase ${phase.id}`);
    }
  }
}

/* ------------------------------------------------------------------ battle */

/**
 * The Battle phase. Rules.md §11 runs five steps in a fixed order, each
 * waiting on one player, so it is driven as a small state machine hanging off
 * `state.battle` rather than folded into the turn's phases — battle is
 * declared from within Main and returns there (§10 ④(4)).
 *
 * Quick effects and interrupts (§13–14) are not built, so the combat-open
 * step here is just each side's one optional open, defender first.
 */

/** Rules.md §10 ④(4) — declare against a city you do not occupy, once each. */
function declareBattle(
  ctx: EngineContext,
  draft: Draft<GameState>,
  actor: PlayerId,
  cityIndex: number,
  events: GameEvent[],
): Result<true, RuleViolation> {
  if (draft.battle) {
    return violation('ALREADY_ACTED', 'A battle is already under way.', '§11');
  }
  const city = draft.cities[cityIndex];
  if (!city) return violation('ILLEGAL_TARGET', 'No such city.', '§5');
  if (city.occupiedBy === actor) {
    return violation('ILLEGAL_TARGET', 'You already occupy that city.', '§10');
  }
  if (draft.turn.battledCities.includes(cityIndex)) {
    return violation('ALREADY_ACTED', 'That city has already been battled this turn.', '§10');
  }
  // Something has to lead the attack, so there must be a character able to.
  if (canVanguard(ctx, draft, actor, cityIndex).length === 0) {
    return violation('ILLEGAL_TARGET', 'You have no unlocked character there to lead.', '§11');
  }

  const defender = opponentOf(draft, actor);
  draft.battle = toDraft({
    city: cityIndex,
    attacker: actor,
    defender,
    step: 'vanguard',
    waitingOn: actor,
    vanguard: null,
    participants: [],
    opened: [],
    passes: 0,
    assigning: [],
    pending: [],
    struck: [],
  });
  // Nothing is spent here, and nothing is revealed. Rules.md §10 ④(4) allows
  // one battle per city per turn, and §11 ① lets the attacker name no
  // vanguard, which "ends the Battle phase" before anything has been locked,
  // opened or struck. Charging the city for a fight that never happened made
  // calling one off cost a turn of that area, and turning the city face up
  // here made calling off a way to peek at it — so both wait for the battle
  // to actually commence, which is the vanguard stepping forward. See
  // `designateVanguard`. A declaration called off leaves the board exactly as
  // it found it.

  // Remembered for cards that ask "if a battle was declared in this area
  // this turn" (BK1-065) — a declaration counts even if it is called off.
  if (!draft.turn.declaredCities.includes(cityIndex)) {
    draft.turn.declaredCities = toDraft([...draft.turn.declaredCities, cityIndex]);
  }
  events.push({ type: 'BATTLE_DECLARED', city: cityIndex, attacker: actor });
  events.push({ type: 'BATTLE_STEP', step: 'vanguard', waitingOn: actor });
  // The defender may want to answer before a vanguard is even named.
  offerQuick(ctx, draft, actor, 'combat', events);
  return ok(true);
}

function battleStep(
  draft: Draft<GameState>,
  step: BattleStep,
  waitingOn: PlayerId,
  events: GameEvent[],
): void {
  const battle = draft.battle;
  if (!battle) return;
  battle.step = step;
  battle.waitingOn = waitingOn;
  events.push({ type: 'BATTLE_STEP', step, waitingOn });
}

/**
 * Is the battle asking this player something they could actually answer?
 *
 * A combat open with nothing openable in the contested city, or a commitment
 * step with nobody left to commit, is a prompt whose only answer is "no" —
 * and being made to say so out loud, on the opponent's turn, is worse than
 * not being asked. The damage step always has an answer, and the vanguard
 * step is a real choice even when there is only one candidate: declining it
 * calls the battle off.
 */
function battleOffersAChoice(
  ctx: EngineContext,
  draft: Draft<GameState>,
  battle: BattleState,
): boolean {
  // §11 ④ — the striker spends all of its Power among enemy participants. With
  // one enemy left standing there is only one legal split: every point goes
  // there. Asking would be offering a single button, and the player has to
  // press it before the battle can finish.
  //
  // Two or more is a real decision — concentrating kills one, spreading may
  // kill neither — and is always asked. So is a striker with no Power, whose
  // one legal answer is an empty assignment.
  if (battle.step === 'damage') return damageTargets(draft, battle).length > 1;

  if (battle.step !== 'opens' && battle.step !== 'commit') return true;

  const wanted = battle.step === 'opens' ? 'OPEN_CARD' : 'COMMIT_CHARACTER';
  return legalActions(ctx, draft as GameState, battle.waitingOn).some(
    (action) => action.type === wanted,
  );
}

/**
 * Enemies the current striker could still be assigned onto. Rules.md §11 ④.
 *
 * Read off the battle rather than the city: only *participants* can be hit,
 * and a character destroyed by an earlier band has left the field and is no
 * longer among them.
 */
function damageTargets(draft: Draft<GameState>, battle: BattleState): CardInstanceId[] {
  const striker = battle.assigning[0];
  const owner = striker ? draft.cards[striker]?.controller : undefined;
  if (owner === undefined) return [];

  return stillFighting(draft as GameState, battle, opponentOf(draft, owner)).map(
    (card) => card.instanceId,
  );
}

/**
 * Answers for a player who has nothing to say, so a battle never stops on a
 * question with one possible answer.
 *
 * Bounded because a rules bug here would spin forever, but the bound has to
 * clear a whole exchange: every participant on both sides can strike, one band
 * at a time (§11 ④), and a forced assignment is answered here rather than by
 * the player. Two per participant is far more than the steps a battle has.
 */
function settleBattle(ctx: EngineContext, draft: Draft<GameState>, events: GameEvent[]): void {
  const limit = Math.max(8, (draft.battle?.participants.length ?? 0) * 2 + 8);
  for (let guard = 0; guard < limit; guard++) {
    // A battle cannot be answered for a player who is mid-question: the card
    // they are still resolving may be about to change what the step offers.
    if (draft.quick || draft.pending) return;
    const battle = draft.battle;
    if (!battle || battleOffersAChoice(ctx, draft, battle)) return;

    // §11 ④ — damage is assigned, never passed, so the forced split is spent
    // here rather than routed through `battlePass`, which rightly refuses it.
    const result =
      battle.step === 'damage'
        ? forcedAssignment(ctx, draft, battle, events)
        : battlePass(ctx, draft, battle.waitingOn, events);
    if (!result.ok) return;
  }
}

/**
 * Spends a striker's whole Power on the only enemy it could hit. Rules.md
 * §11 ④.
 *
 * Only ever called once {@link battleOffersAChoice} has established there is
 * nothing to choose between — at most one target — so this is the assignment
 * the player would have been made to confirm.
 */
function forcedAssignment(
  ctx: EngineContext,
  draft: Draft<GameState>,
  battle: BattleState,
  events: GameEvent[],
): Result<true, RuleViolation> {
  const striker = battle.assigning[0];
  if (striker === undefined) return violation('WRONG_PHASE', 'Nobody is striking.', '§11');
  const card = draft.cards[striker];
  if (!card) return violation('CARD_NOT_IN_ZONE', 'No such card.', '§11');

  const power = powerOf(ctx, draft, card as CardInstance);
  const target = damageTargets(draft, battle)[0];
  // No Power, or nobody left to hit: the strike resolves as an empty
  // assignment rather than stalling the battle on an impossible question.
  const hits = target !== undefined && power > 0 ? [{ target, amount: power }] : [];

  return assignDamage(ctx, draft, card.controller, striker, hits, events);
}

/**
 * Runs {@link settleBattle} after anything that could have moved a battle on.
 * Applied at the dispatch site rather than inside each handler so that every
 * route into a step — including a combat open — is covered by one rule.
 */
function settled(
  ctx: EngineContext,
  draft: Draft<GameState>,
  events: GameEvent[],
  result: Result<true, RuleViolation>,
): Result<true, RuleViolation> {
  if (result.ok) settleBattle(ctx, draft, events);
  return result;
}

/** Rules.md §11 ① — name the lead character and lock it. */
function designateVanguard(
  ctx: EngineContext,
  draft: Draft<GameState>,
  actor: PlayerId,
  cardId: CardInstanceId,
  events: GameEvent[],
): Result<true, RuleViolation> {
  const battle = draft.battle;
  if (!battle || battle.step !== 'vanguard') {
    return violation('WRONG_PHASE', 'No vanguard is being designated.', '§11');
  }
  if (actor !== battle.attacker) {
    return violation('NOT_YOUR_TURN', 'Only the attacker names the vanguard.', '§11');
  }
  const eligible = canVanguard(ctx, draft, actor, battle.city);
  if (!eligible.some((card) => card.instanceId === cardId)) {
    return violation('ILLEGAL_TARGET', 'That character cannot lead the attack.', '§11');
  }

  const card = draft.cards[cardId];
  if (!card) return violation('CARD_NOT_IN_ZONE', 'No such card.', '§11');
  card.locked = true;
  battle.vanguard = cardId;
  battle.participants = toDraft([cardId]);

  // The battle has actually commenced, so the city's one battle this turn
  // (Rules.md §10 ④(4)) is spent now rather than on the declaration. Naming a
  // vanguard is the first irreversible thing in §11 — it locks the character —
  // and the step before it exists precisely so the attacker can back out.
  if (!draft.turn.battledCities.includes(battle.city)) {
    draft.turn.battledCities = toDraft([...draft.turn.battledCities, battle.city]);
  }

  events.push({ type: 'VANGUARD_DESIGNATED', card: cardId });

  // And being attacked is what wakes a city up. Rules.md §5 — until now it
  // lay face-down and neutral, contributing nothing to City Level. Here and
  // not at the declaration, for the same reason the allowance is: an attack
  // that can still be called off must not have shown anybody the city.
  const city = draft.cities[battle.city];
  if (city && !city.faceUp) {
    city.faceUp = true;
    events.push({
      type: 'CITY_FLIPPED',
      city: battle.city,
      faceUp: true,
      cityLevel: cityLevel(draft),
    });
  }
  // §13 — "when this character attacks". The vanguard is in the fight the
  // moment it is named, and its own conditions can now see the battle.
  fireAbilities(ctx, draft, card as CardInstance, 'attack', events);
  offerQuick(ctx, draft, actor, 'attack', events);

  // §11 ② — the defender's optional open comes first.
  beginOpens(ctx, draft, events);
  return ok(true);
}

/** Rules.md §11 ② — one optional open each, defender first. */
function beginOpens(ctx: EngineContext, draft: Draft<GameState>, events: GameEvent[]): void {
  const battle = draft.battle;
  if (!battle) return;
  battleStep(draft, 'opens', battle.defender, events);
}

/** Moves past whoever has just opened or declined. */
function advanceOpens(ctx: EngineContext, draft: Draft<GameState>, events: GameEvent[]): void {
  const battle = draft.battle;
  if (!battle) return;
  if (!battle.opened.includes(battle.defender)) {
    battleStep(draft, 'opens', battle.defender, events);
    return;
  }
  if (!battle.opened.includes(battle.attacker)) {
    battleStep(draft, 'opens', battle.attacker, events);
    return;
  }
  beginCommit(ctx, draft, events);
}

/**
 * Rules.md §11 ③ — players alternate committing, attacker first.
 *
 * The occupying defender is the exception: their whole garrison joins at
 * once, locked or not, because holding a city means defending it with
 * everything there.
 */
function beginCommit(ctx: EngineContext, draft: Draft<GameState>, events: GameEvent[]): void {
  const battle = draft.battle;
  if (!battle) return;

  const city = draft.cities[battle.city];
  if (city?.occupiedBy === battle.defender) {
    for (const card of presenceIn(ctx, draft, battle.city, battle.defender)) {
      if (battle.participants.includes(card.instanceId)) continue;
      // An occupier's garrison is committed for them, but a character barred
      // from the fight is still barred — it is not chosen for it at all.
      if (cannotBattle(draft, card)) continue;
      battle.participants.push(card.instanceId);
      events.push({
        type: 'CHARACTER_COMMITTED',
        card: card.instanceId,
        player: battle.defender,
      });
    }
  }

  battle.passes = 0;
  battleStep(draft, 'commit', battle.attacker, events);
}

/** Rules.md §11 ③ — add one character, locking it. */
function commitCharacter(
  ctx: EngineContext,
  draft: Draft<GameState>,
  actor: PlayerId,
  cardId: CardInstanceId,
  events: GameEvent[],
): Result<true, RuleViolation> {
  const battle = draft.battle;
  if (!battle || battle.step !== 'commit') {
    return violation('WRONG_PHASE', 'Nothing is being committed.', '§11');
  }
  if (actor !== battle.waitingOn) {
    return violation('NOT_YOUR_TURN', 'It is not your turn to commit.', '§11');
  }
  if (!canCommit(ctx, draft, battle, actor).some((card) => card.instanceId === cardId)) {
    return violation('ILLEGAL_TARGET', 'That character cannot join the battle.', '§11');
  }

  const card = draft.cards[cardId];
  if (!card) return violation('CARD_NOT_IN_ZONE', 'No such card.', '§11');
  card.locked = true;
  battle.participants.push(cardId);
  battle.passes = 0;
  events.push({ type: 'CHARACTER_COMMITTED', card: cardId, player: actor });
  // §13 — joining the attack is attacking, for a character on that side.
  if (actor === battle.attacker) {
    fireAbilities(ctx, draft, card as CardInstance, 'attack', events);
  }

  battleStep(draft, 'commit', otherSide(battle, actor), events);
  return ok(true);
}

const otherSide = (battle: BattleState, player: PlayerId): PlayerId =>
  player === battle.attacker ? battle.defender : battle.attacker;

/** Declines whatever the current step asks. Rules.md §11. */
function battlePass(
  ctx: EngineContext,
  draft: Draft<GameState>,
  actor: PlayerId,
  events: GameEvent[],
): Result<true, RuleViolation> {
  const battle = draft.battle;
  if (!battle) return violation('WRONG_PHASE', 'No battle is under way.', '§11');
  if (actor !== battle.waitingOn) {
    return violation('NOT_YOUR_TURN', 'The battle is not waiting on you.', '§11');
  }

  switch (battle.step) {
    case 'vanguard':
      // §11 ① — no vanguard, no battle. Nothing has been locked or spent.
      endBattle(ctx, draft, events, { withoutFighting: true });
      return ok(true);

    case 'opens':
      battle.opened.push(actor);
      advanceOpens(ctx, draft, events);
      return ok(true);

    case 'commit': {
      battle.passes += 1;
      // §11 ③ — two passes in a row ends the commitment step.
      if (battle.passes >= 2) {
        beginDamage(ctx, draft, events);
        return ok(true);
      }
      battleStep(draft, 'commit', otherSide(battle, actor), events);
      return ok(true);
    }

    case 'damage':
      return violation('ILLEGAL_TARGET', 'Damage must be assigned, not passed.', '§11');
  }
}

/** Rules.md §11 ④ — highest Range strikes first, a band at a time. */
function beginDamage(ctx: EngineContext, draft: Draft<GameState>, events: GameEvent[]): void {
  const battle = draft.battle;
  if (!battle) return;

  // §11 ④ — with one side wiped out there is nothing left to strike at, so
  // the exchange stops and the result is read off who is still standing.
  const standing = (player: PlayerId): number =>
    stillFighting(draft as GameState, battle as BattleState, player).length;

  const band = nextRangeBand(ctx, draft, battle);
  if (band.length === 0 || standing(battle.attacker) === 0 || standing(battle.defender) === 0) {
    endBattle(ctx, draft, events);
    return;
  }
  battle.assigning = toDraft(band);
  battle.pending = toDraft([]);

  // The last moment to act before the blows land. DesignNotes "When to offer
  // a Quick" — the one window that is not about the opponent doing
  // something, and the one every combat Quick is written for. Once only,
  // before the first band: §13's "turn player goes first" has the attacker
  // asked and then the defender.
  if (battle.struck.length === 0) {
    offerQuickTo(ctx, draft, battle.attacker, 'beforeDamage', events, battle.defender);
  }

  const first = band[0];
  const card = first ? draft.cards[first] : undefined;
  battleStep(draft, 'damage', card ? card.controller : battle.attacker, events);
}

/** Rules.md §11 ④ — split one character's Power among enemy participants. */
function assignDamage(
  ctx: EngineContext,
  draft: Draft<GameState>,
  actor: PlayerId,
  cardId: CardInstanceId,
  hits: readonly { readonly target: CardInstanceId; readonly amount: number }[],
  events: GameEvent[],
): Result<true, RuleViolation> {
  const battle = draft.battle;
  if (!battle || battle.step !== 'damage') {
    return violation('WRONG_PHASE', 'No damage is being assigned.', '§11');
  }
  const next = battle.assigning[0];
  if (next !== cardId) {
    return violation('NOT_YOUR_TURN', 'Another character strikes first.', '§11');
  }

  const striker = draft.cards[cardId];
  if (!striker) return violation('CARD_NOT_IN_ZONE', 'No such card.', '§11');
  if (striker.controller !== actor) {
    return violation('NOT_YOUR_TURN', 'That is not your character.', '§11');
  }

  const power = powerOf(ctx, draft, striker);
  const total = hits.reduce((sum, hit) => sum + hit.amount, 0);
  if (total !== power) {
    return violation('ILLEGAL_TARGET', `All ${power} Power must be assigned; ${total} was.`, '§11');
  }

  // Targets must be enemy participants still in the fight. A character
  // destroyed by an earlier band has left the field, and one an effect moved
  // out has left the area — neither can be hit here.
  const enemies = new Set(
    stillFighting(draft as GameState, battle as BattleState, opponentOf(draft, actor)).map(
      (card) => card.instanceId,
    ),
  );
  for (const hit of hits) {
    if (hit.amount <= 0) {
      return violation('ILLEGAL_TARGET', 'Every assignment must be at least 1.', '§11');
    }
    if (!enemies.has(hit.target)) {
      return violation('ILLEGAL_TARGET', 'That is not an enemy in this battle.', '§11');
    }
  }

  for (const hit of hits) {
    battle.pending.push({ source: cardId, target: hit.target, amount: hit.amount });
  }
  // It has struck, and does not come round again however high its Range.
  battle.struck.push(cardId);
  battle.assigning.shift();

  const following = battle.assigning[0];
  if (following) {
    const card = draft.cards[following];
    battleStep(draft, 'damage', card ? card.controller : actor, events);
    return ok(true);
  }

  resolveBand(ctx, draft, events);
  return ok(true);
}

/**
 * Applies a whole Range band at once. Rules.md §11 ④ — ties resolve
 * simultaneously, so a character destroyed here has already dealt its damage.
 */
function resolveBand(ctx: EngineContext, draft: Draft<GameState>, events: GameEvent[]): void {
  const battle = draft.battle;
  if (!battle) return;

  for (const hit of battle.pending) {
    let target = draft.cards[hit.target];
    if (!target) continue;
    // BK1-027 — this striker's blows against the protected side come back at
    // it instead. Redirected before reduction, so the blow is softened by
    // whatever the *new* target is wearing rather than the old one.
    const striker = draft.cards[hit.source];
    const protectedSeat = (striker?.counters[REFLECT] ?? 0) - 1;
    if (striker && protectedSeat >= 0 && draft.seats[protectedSeat] === target.controller) {
      target = striker;
    }
    // Reduction bites where the blow lands, not where it was assigned: §11 ④
    // makes the striker spend its Power exactly, so armour makes the wound
    // smaller rather than letting the attacker hold anything back.
    // A ward swallows one blow whole and is spent by it, however big
    // (BK2-024) — unlike a shield, which shrinks every blow by a fixed
    // amount. Checked before reduction: the blow never lands to be reduced.
    if (hasWard(target as CardInstance)) {
      target.counters = { ...target.counters, [WARD]: (target.counters[WARD] ?? 0) - 1 };
      continue;
    }
    const amount = damageAfterReduction(ctx, draft, target as CardInstance, hit.amount, {
      combat: true,
    });
    if (amount === 0) continue;
    target.damage += amount;
    events.push({
      type: 'DAMAGE_DEALT',
      source: hit.source,
      target: target.instanceId,
      amount,
      combat: true,
    });
  }
  battle.pending = toDraft([]);

  for (const id of battle.participants) {
    const card = draft.cards[id];
    if (!card || card.zone !== 'city') continue;
    if (card.damage >= hpOf(ctx, draft, card)) destroy(ctx, draft, card, events);
  }

  refreshBoard(ctx, draft, events);
  beginDamage(ctx, draft, events);
}

/** Rules.md §11 ⑤ and §12 — apply the result and return to Main. */
function endBattle(
  ctx: EngineContext,
  draft: Draft<GameState>,
  events: GameEvent[],
  options: { withoutFighting?: boolean } = {},
): void {
  const battle = draft.battle;
  if (!battle) return;

  if (options.withoutFighting) {
    draft.battle = null;
    events.push({
      type: 'BATTLE_ENDED',
      city: battle.city,
      result: 'stalemate',
      occupier: null,
    });
    return;
  }

  const result = battleResult(ctx, draft, battle);
  const city = draft.cities[battle.city];
  let occupier: PlayerId | null = null;

  if (result === 'occupation' && city) {
    // §12 — you only take a city by attacking into it successfully.
    if (city.occupiedBy !== battle.attacker) {
      city.occupiedBy = battle.attacker;
      occupier = battle.attacker;
      // "If you captured this area this turn" (BK1-039). Rules.md §13.
      draft.turn.capturedCities = toDraft([...draft.turn.capturedCities, battle.city]);
      events.push({ type: 'CITY_OCCUPIED', city: battle.city, player: battle.attacker });
      // §12 — the city card's own effect: a fresh occupation draws two,
      // unless an attacker present says otherwise (BK1-093).
      drawInto(draft, battle.attacker, captureDrawFor(ctx, draft, battle), events);
      // Cards that answer to the other player taking a city (BK1-158).
      fireEnemyCapture(ctx, draft, battle.attacker, battle.city, events);
    }
  } else if (result === 'mutual_destruction' && city && city.occupiedBy) {
    city.occupiedBy = null;
    events.push({ type: 'CITY_OCCUPIED', city: battle.city, player: null });
  }

  draft.battle = null;
  events.push({ type: 'BATTLE_ENDED', city: battle.city, result, occupier });
  refreshBoard(ctx, draft, events);
  checkWinConditions(draft, events);
}

/** Rules.md §10 ④(2) — set one card from hand face-down in any city. */
function setCard(
  draft: Draft<GameState>,
  actor: PlayerId,
  cardId: CardInstanceId,
  city: number,
  events: GameEvent[],
): Result<true, RuleViolation> {
  if (currentPhase(draft).id !== 'main') {
    return violation('WRONG_PHASE', 'Cards may only be set during your Main phase.', '§10');
  }
  const card = draft.cards[cardId];
  if (!card) return violation('UNKNOWN_CARD', 'No such card.');
  if (card.zone !== 'hand' || card.controller !== actor) {
    return violation('CARD_NOT_IN_ZONE', 'That card is not in your hand.', '§10');
  }
  if (!draft.cities[city]) {
    return violation('ILLEGAL_TARGET', 'No such city.', '§5');
  }

  moveToCity(draft, cardId, city, { controller: actor, faceUp: false });
  events.push({ type: 'CARD_SET', player: actor, card: cardId, city });
  return ok(true);
}

/**
 * Rules.md §7 — flip a Set Card face-up and pay its cost.
 *
 * The rulebook says a card opened above the City Level "simply becomes a Set
 * Card again" with no cost paid, because in paper you flip before checking.
 * A digital client knows the level up front, so we reject the attempt instead
 * of consuming the player's one open per turn.
 */
/**
 * Rules.md §11 ② — the combat open, which is the same open under different
 * conditions: inside a battle, in the contested city, one per side.
 */
function battleOpenAllowed(
  draft: Draft<GameState>,
  actor: PlayerId,
  card: CardInstance,
): Result<true, RuleViolation> {
  const battle = draft.battle;
  if (!battle) return ok(true);
  if (battle.step !== 'opens') {
    return violation('WRONG_PHASE', 'Cards cannot be opened during this step.', '§11');
  }
  if (actor !== battle.waitingOn) {
    return violation('NOT_YOUR_TURN', 'It is not your combat open.', '§11');
  }
  if (card.cityIndex !== battle.city) {
    return violation('ILLEGAL_TARGET', 'Only a card in the contested city may be opened.', '§11');
  }
  return ok(true);
}

function openCard(
  ctx: EngineContext,
  draft: Draft<GameState>,
  actor: PlayerId,
  cardId: CardInstanceId,
  pay: readonly CardInstanceId[],
  targets: readonly CardInstanceId[],
  areas: readonly number[],
  events: GameEvent[],
): Result<true, RuleViolation> {
  const card = draft.cards[cardId];
  if (!card) return violation('UNKNOWN_CARD', 'No such card.');
  if (card.zone !== 'city' || card.faceUp || card.controller !== actor) {
    return violation('CARD_NOT_IN_ZONE', 'That is not one of your Set Cards.', '§7');
  }

  // Three ways a card can be opened, and they have different rules.
  //
  // A Quick window (§13) is the loosest: Quick frees the *timing*, so the
  // phase does not matter and the turn's one open is untouched — it is not
  // your turn at all. It outranks the battle case below, because a window can
  // open in the middle of one.
  const inWindow = draft.quick !== null && draft.quick.waitingOn === actor;

  // A battle brings its own open step (Rules.md §11 ②), which is separate from
  // the turn's Open phase and from its one-open limit: the defender opens on
  // the attacker's turn, and the attacker may already have opened this turn.
  const inBattle = !inWindow && draft.battle !== null;

  if (inWindow) {
    if (!definitionOf(ctx, card as CardInstance).quick) {
      return violation('WRONG_PHASE', 'Only a Quick card can be opened right now.', '§13');
    }
    // A window offers what is worth opening now (`rules.ts:quickRelevant`),
    // and the reducer has to agree with the offer — a card that would do
    // nothing is refused rather than spent for nothing.
    if (!quickCardRelevant(ctx, draft as GameState, card as CardInstance)) {
      return violation('WRONG_PHASE', 'That card would do nothing right now.', '§13');
    }
  } else if (inBattle) {
    const allowed = battleOpenAllowed(draft, actor, card as CardInstance);
    if (!allowed.ok) return allowed;
  } else {
    const phase = currentPhase(draft).id;
    if (phase !== 'open') {
      return violation('WRONG_PHASE', 'Cards may only be opened during your Open phase.', '§10');
    }
    if (draft.turn.openedThisTurn) {
      return violation('ALREADY_ACTED', 'You may only open one card per turn.', '§10');
    }
  }

  const city = card.cityIndex ?? -1;
  const def = definitionOf(ctx, card as CardInstance);

  // A card whose printed level or cost has not been captured cannot be opened.
  // Treating unknown as free or as Level 0 would silently let illegal plays
  // through; refusing says plainly what is missing. See Docs/CardData.md.
  if (def.level === null || def.cost === null) {
    return violation(
      'NOT_IMPLEMENTED',
      `${def.name}: this card's printed ${def.level === null ? 'level' : 'cost'} has not been captured yet, so it cannot be opened.`,
      '§7',
    );
  }

  // Shut for the turn by a card that said so (BK1-031). Rules.md §7.
  if ((card.counters[SEALED] ?? 0) > 0) {
    return violation('WRONG_PHASE', `${def.name} cannot be opened this turn.`, '§7');
  }
  // A card on the board may narrow what this player can open (BK1-116).
  const level = openLevelFor(ctx, draft, actor);
  if (def.level > level) {
    return violation(
      'WRONG_PHASE',
      `${def.name} is Level ${def.level}; only ${level} cit${level === 1 ? 'y is' : 'ies are'} face up.`,
      '§7',
    );
  }
  if (uniqueConflict(ctx, draft, def)) {
    return violation('ILLEGAL_TARGET', `${def.name} is Unique and already on the field.`, '§8');
  }
  // "This card can only be opened if …" — Rules.md §13, `Ability.gate`. The
  // condition is read before anything is paid, so a shut gate costs nothing.
  const shut = abilitiesOf(ctx, card as CardInstance).find(
    (ability) =>
      ability.trigger === 'open' &&
      ability.gate === true &&
      !conditionHolds(
        ctx,
        draft as GameState,
        card as CardInstance,
        ability.condition,
        draft.battle,
      ),
  );
  if (shut) {
    return violation('WRONG_PHASE', `${def.name} cannot be opened now: ${shut.text}`, '§13');
  }

  const payCards: CardInstance[] = [];
  for (const id of pay) {
    const payCard = draft.cards[id];
    if (!payCard || payCard.zone !== 'hand' || payCard.controller !== actor) {
      return violation('CARD_NOT_IN_ZONE', 'Cost must be paid with cards from your hand.', '§7');
    }
    payCards.push(payCard as CardInstance);
  }

  const payment = validatePayment(ctx, def.cost, payCards);
  if (!payment.ok) return payment;

  for (const id of pay) {
    moveToZone(draft, id, { player: actor, zone: 'trash' });
    events.push({ type: 'CARD_TRASHED', player: actor, card: id });
  }
  if (pay.length > 0) events.push({ type: 'COST_PAID', player: actor, cards: [...pay] });

  card.faceUp = true;
  // Remembered so "the turn it is opened" can still be asked later in the
  // turn. Rules.md §7 — cleared when the card leaves the field.
  card.counters[OPENED_ON_TURN] = turnOrdinal(draft);
  // BK2-046 — while it stands, whatever is opened arrives locked (§6, §7).
  if (isCharacter(ctx, card as CardInstance) && opensLocked(ctx, draft)) card.locked = true;
  if (!inBattle && !inWindow) draft.turn.openedThisTurn = true;
  events.push({ type: 'CARD_OPENED', player: actor, card: cardId, city });
  // A character turning up here is an arrival, exactly as a move is (§13).
  fireArrival(ctx, draft, card, events);

  // Rules.md §14 — what the card does goes *pending*, and resolves once both
  // players have passed on it (or at once, if neither can respond). A Normal
  // Effect leaves for the Trash after its last effect has resolved.
  const chosen = checkTargets(ctx, draft, card as CardInstance, targets, areas);
  if (!chosen.ok) return chosen;
  const stacked = stackEffects(ctx, draft, card as CardInstance, chosen.value, events);
  if (!stacked && def.kind === 'effect' && def.duration === 'normal') {
    // Nothing to do: a Normal with no built behaviour resolves to nothing.
    moveToZone(draft, cardId, { player: actor, zone: 'trash' });
    events.push({ type: 'CARD_TRASHED', player: actor, card: cardId });
  }

  // A character opened into the contested city is now standing in it, which
  // can flip the city and change what the battle is being fought over.
  refreshBoard(ctx, draft, events);

  if (inBattle && draft.battle) {
    // §11 ② — one open each, then on to commitment.
    draft.battle.opened.push(actor);
    advanceOpens(ctx, draft, events);
  }

  if (stacked) {
    // A round of priority over what was just stacked. Rules.md §14 — turn
    // player first. If this open was itself a response, the window it was
    // played in is remembered and comes back once the stack has drained.
    startRound(ctx, draft, events, inWindow ? resumeOf(draft) : null);
  } else if (!inWindow) {
    // A card with nothing pending: the other player may still want to
    // answer the open itself. DesignNotes "When to offer a Quick".
    offerQuick(ctx, draft, actor, 'cardOpened', events);
  }

  return ok(true);
}

/** Rules.md §10 ④(1) — lock an unlocked character and move it within its Move. */
function moveCharacter(
  ctx: EngineContext,
  draft: Draft<GameState>,
  actor: PlayerId,
  cardId: CardInstanceId,
  city: number,
  events: GameEvent[],
): Result<true, RuleViolation> {
  if (currentPhase(draft).id !== 'main') {
    return violation('WRONG_PHASE', 'Characters may only move during your Main phase.', '§10');
  }

  const card = draft.cards[cardId];
  if (!card) return violation('UNKNOWN_CARD', 'No such card.');
  if (card.zone !== 'city' || !card.faceUp || card.controller !== actor) {
    return violation('CARD_NOT_IN_ZONE', 'That character is not on the field.', '§10');
  }
  if (!isCharacter(ctx, card as CardInstance)) {
    return violation('ILLEGAL_TARGET', 'Only characters can move.', '§10');
  }
  if (card.locked) {
    return violation('ALREADY_ACTED', 'That character is locked.', '§6');
  }
  if (!draft.cities[city]) {
    return violation('ILLEGAL_TARGET', 'No such city.', '§5');
  }

  const from = card.cityIndex ?? -1;
  if (from === city) {
    return violation('ILLEGAL_TARGET', 'That character is already there.', '§10');
  }

  const def = definitionOf(ctx, card as CardInstance);
  const move = moveOf(ctx, draft, card as CardInstance);
  const distance = cityDistance(from, city);
  if (distance > move) {
    return violation(
      'ILLEGAL_TARGET',
      `${def.name} has Move ${move} but that city is ${distance} away.`,
      '§10',
    );
  }

  // BK1-157 — pinned in place: leaving destroys it. Checked before the move,
  // because the clause is read off the two standing together (§13).
  const doomedByLeaving = diesIfItLeaves(ctx, draft, card as CardInstance);

  // Rules.md §6 — moving locks the character.
  card.locked = true;
  card.cityIndex = city;
  arrived(draft, actor, city);
  events.push({ type: 'CHARACTER_MOVED', card: cardId, from, to: city });
  if (doomedByLeaving) {
    destroy(ctx, draft, card, events);
    return ok(true);
  }
  fireAbilities(ctx, draft, card as CardInstance, 'selfMoved', events);
  fireArrival(ctx, draft, card, events);
  return ok(true);
}

/** Rules.md §10 ⑤ — discard down to seven cards at end of turn. */
function discardCard(
  draft: Draft<GameState>,
  actor: PlayerId,
  cardId: CardInstanceId,
  events: GameEvent[],
): Result<true, RuleViolation> {
  if (currentPhase(draft).id !== 'end') {
    return violation('WRONG_PHASE', 'You only discard during the End phase.', '§10');
  }
  const card = draft.cards[cardId];
  if (!card || card.zone !== 'hand' || card.controller !== actor) {
    return violation('CARD_NOT_IN_ZONE', 'That card is not in your hand.', '§10');
  }
  if (handSize(draft, actor) <= HAND_LIMIT) {
    return violation('ALREADY_ACTED', `Your hand is already at ${HAND_LIMIT} cards.`, '§10');
  }

  moveToZone(draft, cardId, { player: actor, zone: 'trash' });
  events.push({ type: 'CARD_TRASHED', player: actor, card: cardId });
  return ok(true);
}

function concede(draft: Draft<GameState>, actor: PlayerId, events: GameEvent[]): void {
  const player = draft.players[actor];
  if (player) player.eliminated = true;

  const winner = opponentOf(draft, actor);
  events.push({ type: 'MATCH_ENDED', winner, reason: 'concede' });
  draft.status = { kind: 'finished', winner, reason: 'concede' };
}

/* ------------------------------------------------------------------ phases */

export function currentPhase(draft: Pick<GameState, 'phases' | 'turn'>): PhaseDef {
  const phase = draft.phases[draft.turn.phaseIndex];
  if (!phase) throw new Error(`Invalid phase index: ${draft.turn.phaseIndex}`);
  return phase;
}

/** Two-player assumption, per Rules.md §2 ("strictly 2-player"). */
function opponentOf(draft: Pick<GameState, 'seats'>, player: PlayerId): PlayerId {
  const other = draft.seats.find((seat) => seat !== player);
  if (!other) throw new Error(`No opponent found for ${player}`);
  return other;
}

const handSize = (draft: Pick<GameState, 'zoneOrder'>, player: PlayerId): number =>
  (draft.zoneOrder[zoneKey(player, 'hand')] ?? []).length;

function endPhase(
  ctx: EngineContext,
  draft: Draft<GameState>,
  actor: PlayerId,
  events: GameEvent[],
): Result<true, RuleViolation> {
  if (actor !== draft.turn.activePlayer) {
    return violation('NOT_YOUR_TURN', 'Only the turn player ends a phase.', '§10');
  }
  // Rules.md §10 ⑤ — the turn cannot pass while over the hand limit.
  if (currentPhase(draft).id === 'end' && handSize(draft, actor) > HAND_LIMIT) {
    return violation(
      'ALREADY_ACTED',
      `Discard down to ${HAND_LIMIT} cards before ending your turn.`,
      '§10',
    );
  }

  advancePhase(ctx, draft, events);
  return ok(true);
}

/** Advances one phase, rolling over into the opponent's turn after the End phase. */
function advancePhase(ctx: EngineContext, draft: Draft<GameState>, events: GameEvent[]): void {
  const nextIndex = draft.turn.phaseIndex + 1;

  if (nextIndex >= draft.phases.length) {
    beginTurn(ctx, draft, opponentOf(draft, draft.turn.activePlayer), events);
    return;
  }

  draft.turn.phaseIndex = nextIndex;
  draft.turn.priorityPlayer = draft.turn.activePlayer;
  const arrived = currentPhase(draft).id;
  events.push({ type: 'PHASE_CHANGED', phaseId: arrived, player: draft.turn.activePlayer });
  if (arrived === 'main') offerQuick(ctx, draft, draft.turn.activePlayer, 'mainPhase', events);
  if (arrived === 'end') offerQuick(ctx, draft, draft.turn.activePlayer, 'turnEnd', events);

  settle(ctx, draft, events);
}

function beginTurn(
  ctx: EngineContext,
  draft: Draft<GameState>,
  player: PlayerId,
  events: GameEvent[],
  options: { firstTurn?: boolean } = {},
): void {
  const startingPlayer = draft.seats[0];
  const turnNumber = options.firstTurn
    ? 1
    : player === startingPlayer
      ? draft.turn.turnNumber + 1
      : draft.turn.turnNumber;

  draft.turn = {
    activePlayer: player,
    priorityPlayer: player,
    phaseIndex: 0,
    turnNumber,
    openedThisTurn: false,
    battledCities: [],
    declaredCities: [],
    capturedCities: [],
    arrivals: [],
    drawSkipped: false,
    drawAtEnd: 0,
  };

  events.push({ type: 'TURN_STARTED', player, turnNumber });
  events.push({ type: 'PHASE_CHANGED', phaseId: currentPhase(draft).id, player });
  // Rules.md §13 — "at the start of your turn" abilities, before the phases
  // run, so what they draw is in hand by the Draw step.
  fireTurnTrigger(ctx, draft, player, 'turnStart', events);
  offerQuick(ctx, draft, player, 'turnStart', events);
  settle(ctx, draft, events);
}

/**
 * Runs the automatic phases (Refresh, Draw, End) until the turn rests on a
 * phase that needs a decision. Rules.md §10.
 */
function settle(ctx: EngineContext, draft: Draft<GameState>, events: GameEvent[]): void {
  // Bounded to stop a rules bug from spinning forever; two turns of phases is
  // far more than any legal chain of automatic advances.
  for (let guard = 0; guard < draft.phases.length * 2 + 2; guard++) {
    if (draft.status.kind === 'finished') return;
    // A window freezes the game where it stands, and so does an effect that
    // stopped to ask. Rules.md §13.
    if (draft.quick || draft.pending) return;

    const phase = currentPhase(draft);
    const player = draft.turn.activePlayer;

    switch (phase.id) {
      case 'refresh':
        applyRefresh(draft, player, events);
        break;
      case 'draw':
        if (!applyDraw(draft, player, events)) return; // deck-out ends the match
        break;
      case 'end':
        applyEndOfTurn(ctx, draft, player, events);
        // The turn player still has to discard down before passing.
        if (handSize(draft, player) > HAND_LIMIT) return;
        break;
      default:
        break;
    }

    // DesignNotes 7 — nothing is set yet on turn one, so there is no Open
    // step; the Open phase only becomes meaningful from a player's second turn.
    const skipOpen = phase.id === 'open' && draft.turn.turnNumber === 1;
    if (!phase.autoAdvance && !skipOpen && !hasNothingToDo(ctx, draft, player)) return;

    const nextIndex = draft.turn.phaseIndex + 1;
    if (nextIndex >= draft.phases.length) {
      beginTurn(ctx, draft, opponentOf(draft, player), events);
      return;
    }

    draft.turn.phaseIndex = nextIndex;
    draft.turn.priorityPlayer = player;
    const arrived = currentPhase(draft).id;
    events.push({ type: 'PHASE_CHANGED', phaseId: arrived, player });
    // DesignNotes "When to offer a Quick" — reaching Main, and reaching the
    // End phase, are two of the six moments worth interrupting.
    if (arrived === 'main') offerQuick(ctx, draft, player, 'mainPhase', events);
    if (arrived === 'end') offerQuick(ctx, draft, player, 'turnEnd', events);
  }
}

/**
 * Is there anything to do here but leave?
 *
 * A phase that offers only "next phase" is a click with no decision in it —
 * an Open step with nothing openable, or a Main phase with an empty hand and
 * every character locked. The engine already knows exactly what is possible,
 * so it moves on rather than making the player say so.
 *
 * Deliberately phrased as "nothing else is legal" rather than as a list of
 * cases: as actions are added — abilities, Quick effects — they count here
 * for free, and a phase can never be skipped past something a player could
 * have done.
 */
function hasNothingToDo(ctx: EngineContext, draft: Draft<GameState>, player: PlayerId): boolean {
  // A battle has its own steps and its own waiting player; never skip through
  // one. Rules.md §11. Nor a Quick window, which stops the game outright.
  if (draft.battle || draft.quick) return false;

  return legalActions(ctx, draft as GameState, player).every(
    (action) => action.type === 'CONCEDE' || action.type === 'END_PHASE',
  );
}

/** Rules.md §10 ① — unlock all of the turn player's locked cards. */
function applyRefresh(draft: Draft<GameState>, player: PlayerId, events: GameEvent[]): void {
  let count = 0;
  for (const card of Object.values(draft.cards)) {
    if (card.controller === player && card.zone === 'city' && card.locked) {
      // BK1-085 — a character may owe this Refresh to a Creeping Nightmare.
      // One skip is spent per Refresh and the card stays down, so two marks
      // cost it two turns rather than collapsing into one.
      const owed = card.counters[SKIP_REFRESH] ?? 0;
      if (owed > 0) {
        card.counters = { ...card.counters, [SKIP_REFRESH]: owed - 1 };
        continue;
      }
      card.locked = false;
      count++;
    }
  }
  if (count > 0) events.push({ type: 'CARDS_UNLOCKED', player, count });
}

/**
 * Rules.md §10 ② — draw 1, skipped on the first player's first turn.
 * Rules.md §1 — being required to draw from an empty deck loses the match.
 * Returns false if the match ended.
 */
function applyDraw(draft: Draft<GameState>, player: PlayerId, events: GameEvent[]): boolean {
  // Given up this turn for cards later (BK1-066). Rules.md §13.
  if (draft.turn.drawSkipped) return true;
  const isFirstPlayersFirstTurn = draft.turn.turnNumber === 1 && player === draft.seats[0];
  if (isFirstPlayersFirstTurn) return true;
  return drawInto(draft, player, 1, events);
}

/**
 * Draws cards, ending the match if the deck runs dry. Returns false if it did.
 *
 * Separate from `applyDraw` because that one carries the Draw-phase rule about
 * the first player's first turn (Rules.md §10 ②), which has nothing to do with
 * drawing for any other reason — occupying a city, say.
 */
function drawInto(
  draft: Draft<GameState>,
  player: PlayerId,
  count: number,
  events: GameEvent[],
): boolean {
  for (let i = 0; i < count; i++) {
    const deck = draft.zoneOrder[zoneKey(player, 'deck')] ?? [];
    if (deck.length === 0) {
      const winner = opponentOf(draft, player);
      const loser = draft.players[player];
      if (loser) loser.eliminated = true;
      draft.status = { kind: 'finished', winner, reason: 'deck_out' };
      events.push({ type: 'MATCH_ENDED', winner, reason: 'deck_out' });
      return false;
    }
    const next = drawCards(draft as GameState, player, 1);
    draft.cards = toDraft(next.cards);
    draft.zoneOrder = toDraft(next.zoneOrder);
    events.push(...next.log.slice(draft.log.length));
  }
  return true;
}

/** Rules.md §10 ⑤ — all damage resets to 0. */
function applyEndOfTurn(
  ctx: EngineContext,
  draft: Draft<GameState>,
  player: PlayerId,
  events: GameEvent[],
): void {
  // Cards owed at the end of the turn in place of the Draw phase (BK1-066),
  // before anything else the end of the turn does.
  if (draft.turn.drawAtEnd > 0) {
    drawInto(draft, player, draft.turn.drawAtEnd, events);
    draft.turn.drawAtEnd = 0;
  }
  // Rules.md §13 — "at the end of the turn" abilities go off before the board
  // is tidied, or a character that returns to hand would be tidied first.
  fireTurnTrigger(ctx, draft, player, 'turnEnd', events);

  let cleared = false;
  for (const card of Object.values(draft.cards)) {
    if (card.damage > 0) {
      card.damage = 0;
      cleared = true;
    }
    // "Until end of turn" needs no timer: the boosts are swept with the
    // damage, in the phase the rules already tidy in. Rules.md §10 ⑤.
    for (const key of BOOST_COUNTERS) {
      if (card.counters[key] !== undefined) delete card.counters[key];
    }
  }
  if (cleared) events.push({ type: 'DAMAGE_CLEARED' });
}

/**
 * Applies a batch of actions in order, stopping at the first violation.
 * Used by replay and by tests that need to reach a mid-game position.
 */
export function reduceAll(
  ctx: EngineContext,
  state: GameState,
  actions: readonly { actor: PlayerId; action: GameAction }[],
): ReduceResult {
  let current = state;
  const events: GameEvent[] = [];

  for (const { actor, action } of actions) {
    const result = reduce(ctx, current, actor, action);
    if (!result.ok) return result;
    current = result.value.state;
    events.push(...result.value.events);
  }

  return ok({ state: current, events });
}

/* ------------------------------------------------------------ quick windows
 *
 * Rules.md §13 lets a Quick interject almost anywhere. Asking after every
 * action turns the game into a dialogue box, so DesignNotes narrows it to six
 * moments — and even then only when the player actually has a Quick set and
 * can pay for it, which is what makes silence meaningful: no prompt means
 * there was nothing to prompt about.
 */

/**
 * Offers a Quick window to whoever did *not* do the thing.
 *
 * A no-op unless they have something to open. That check is the whole design:
 * a window nobody could act in is a click with no decision in it, which is
 * exactly what `hasNothingToDo` refuses to ask elsewhere.
 */
function offerQuick(
  ctx: EngineContext,
  draft: Draft<GameState>,
  actedBy: PlayerId,
  trigger: QuickTrigger,
  events: GameEvent[],
): void {
  const responder = draft.seats.find((seat) => seat !== actedBy);
  if (responder !== undefined) offerQuickTo(ctx, draft, responder, trigger, events);
}

/**
 * Offers a Quick window to a named player, and — if they have nothing to
 * open — to `then` instead, so a two-sided moment falls through to whoever
 * can actually act in it. Rules.md §13.
 */
function offerQuickTo(
  ctx: EngineContext,
  draft: Draft<GameState>,
  responder: PlayerId,
  trigger: QuickTrigger,
  events: GameEvent[],
  then?: PlayerId,
): void {
  // An unfinished effect comes first: the window is offered once the card that
  // opened it has finished resolving, not in the middle of its own line.
  if (draft.quick || draft.pending || draft.status.kind !== 'playing') return;

  // Asked of the window we are about to open, not of the one that is not
  // there yet: a Quick *ability* is only usable inside a window, so probing
  // the current state would answer "nothing to do" every time and no window
  // would ever open for one.
  const candidate: QuickWindow = { waitingOn: responder, trigger, ...(then ? { then } : {}) };
  const probe = { ...(draft as GameState), quick: candidate };
  if (quickOpens(ctx, probe, responder).length === 0) {
    if (then !== undefined) offerQuickTo(ctx, draft, then, trigger, events);
    return;
  }

  draft.quick = toDraft(candidate);
  events.push({ type: 'QUICK_OFFERED', player: responder, trigger });
}

/* --------------------------------------------------------- the stack (§14)
 *
 * Rules.md §14: an opened card's effect, or a used ability's, goes pending;
 * priority passes turn player first, then opponent; a player may interrupt
 * with a Quick, which goes pending on top; two passes in a row resolve the
 * most recent. Only what a player *did* is stacked — see `PendingEffect`.
 */

/**
 * Puts a card's on-open abilities on the stack, in printed order, with the
 * choices made for them. Returns whether anything was stacked.
 */
function stackEffects(
  ctx: EngineContext,
  draft: Draft<GameState>,
  source: CardInstance,
  choices: Choices,
  events: GameEvent[],
): boolean {
  let asked = 0;
  let stacked = 0;
  abilitiesOf(ctx, source).forEach((ability, index) => {
    if (ability.trigger !== 'open') return;
    const asks = ability.target !== undefined || ability.area !== undefined;
    const at = asks ? asked++ : -1;
    const chosen = at >= 0 ? choices.cards[at] : undefined;
    const area = at >= 0 ? choices.areas[at] : undefined;
    // Conditions are read now, as printed: "when this card is opened, if …".
    if (!conditionHolds(ctx, draft, source, ability.condition, draft.battle)) return;
    if (ability.target && chosen === undefined) return;
    if (ability.area && area === undefined) return;
    const entry: PendingEffect = {
      source: source.instanceId,
      controller: source.controller,
      ability: index,
      ...(chosen !== undefined ? { chosen } : {}),
      ...(area !== undefined ? { area } : {}),
    };
    draft.stack = toDraft([...draft.stack, entry]);
    events.push({
      type: 'EFFECT_PENDING',
      player: source.controller,
      card: source.instanceId,
      text: ability.text,
    });
    stacked++;
  });
  return stacked > 0;
}

/** The window a round is interrupting, to come back to. */
function resumeOf(draft: Draft<GameState>): QuickResume | null {
  const window = draft.quick;
  if (!window) return draft.resume;
  if (window.trigger === 'response') return draft.resume;
  return {
    trigger: window.trigger,
    waitingOn: window.waitingOn,
    ...(window.then ? { then: window.then } : {}),
  };
}

/**
 * A round of priority over the top of the stack. Rules.md §14.
 *
 * Asked of the turn player first and then the opponent — and only of a
 * player with a relevant Quick to play, which is what keeps a match from
 * stopping on every open. With nobody to ask, the top resolves at once and
 * the next entry gets its own round; when the stack has drained, whatever
 * moment-window the round interrupted is offered again.
 */
function startRound(
  ctx: EngineContext,
  draft: Draft<GameState>,
  events: GameEvent[],
  after: QuickResume | null,
): void {
  draft.resume = after ? toDraft(after) : null;
  for (let guard = 0; guard < 64; guard++) {
    // An effect stopped to ask: the stack waits for the answer, and
    // `finishChoice` comes back here.
    if (draft.pending || draft.status.kind === 'finished') return;
    if (draft.stack.length === 0) {
      const resume = draft.resume;
      draft.resume = null;
      draft.quick = null;
      if (resume) offerQuickTo(ctx, draft, resume.waitingOn, resume.trigger, events, resume.then);
      return;
    }
    draft.quick = null;
    // Turn player first, then the opponent (§14) — but not the player whose
    // own effect this is, outside a battle: responding to your own draw
    // with another draw is just two opens, and asking every time is the
    // dialogue box DesignNotes forbids. Inside a battle the order of your own
    // tricks can matter, so both are asked.
    const top = draft.stack[draft.stack.length - 1];
    const askers = [draft.turn.activePlayer, opponentOf(draft, draft.turn.activePlayer)].filter(
      (player) => draft.battle !== null || player !== top?.controller,
    );
    const [first, second] = askers;
    if (first !== undefined) offerQuickTo(ctx, draft, first, 'response', events, second);
    if (draft.quick) return;
    resolveTop(ctx, draft, events);
  }
}

/**
 * Resolves the most recently stacked effect. Rules.md §14.
 *
 * The source has to still be on the field, face up, and a chosen target
 * still standing — a Quick played in response may have removed either, in
 * which case the effect fizzles. A Normal Effect goes to the Trash once its
 * last effect has come off the stack (§3).
 */
function resolveTop(ctx: EngineContext, draft: Draft<GameState>, events: GameEvent[]): void {
  const top = draft.stack[draft.stack.length - 1];
  if (!top) return;
  draft.stack = toDraft(draft.stack.slice(0, -1));

  const source = draft.cards[top.source];
  const ability = source
    ? definitionOf(ctx, source as CardInstance).abilities?.[top.ability]
    : undefined;
  // The chosen card has to still be on the field for the effect to land. A
  // face-down one counts as present: an ability aimed at a Set Card (§7 —
  // BK1-031, BK1-030, BK1-128) is pointed at it *because* it is face down,
  // so requiring `faceUp` here fizzled exactly the cards it was written for.
  const aimedAtSetCard = (ability?.target?.faceDown ?? false) === true;
  const chosenCard = top.chosen === undefined ? undefined : draft.cards[top.chosen];
  const chosenGone =
    top.chosen !== undefined &&
    (chosenCard?.zone !== 'city' || (!aimedAtSetCard && chosenCard.faceUp !== true));
  if (source && source.zone === 'city' && source.faceUp && ability && !chosenGone) {
    // "Destroy this card:" — paid now rather than at the moment it was used,
    // so §14's stack does not fizzle the ability as a source that has gone.
    // It is paid *before* the effect, as printed, and goes out through
    // `destroy` so its own death abilities still fire (Rules.md §3).
    if (ability.cost?.destroySelf === true) {
      destroy(ctx, draft, source, events);
    }
    resolveEffect(ctx, draft, source as CardInstance, ability, events, top.chosen, top.area);
  } else if (source && ability) {
    events.push({
      type: 'ABILITY_FIZZLED',
      card: top.source,
      player: top.controller,
      text: ability.text,
    });
  }

  // Rules.md §3 — a Normal Effect resolves once and goes to the Trash, once
  // nothing of it is still pending.
  if (source && source.zone === 'city' && !draft.stack.some((e) => e.source === top.source)) {
    const def = definitionOf(ctx, source as CardInstance);
    if (def.kind === 'effect' && def.duration === 'normal') {
      moveToZone(draft, top.source, { player: source.owner, zone: 'trash' });
      events.push({ type: 'CARD_TRASHED', player: source.owner, card: top.source });
    }
  }
  refreshBoard(ctx, draft, events);
  checkWinConditions(draft, events);
}

/* --------------------------------------------------------------- abilities
 *
 * Rules.md §13. A triggered ability fires once and writes its result into the
 * state; a continuous one is never resolved at all, it is read off the board
 * by `powerOf` and friends. So everything below is about the triggered kind.
 */

/**
 * Checks the player's chosen targets against what the card may point at.
 *
 * One per ability that asks, in printed order. Fewer is allowed — an ability
 * with nobody legal to point at gets nobody, and the open still happens
 * (Rules.md §13 resolves what it can). More, or an illegal one, is a client
 * that has gone wrong or is lying, and is refused.
 */
function checkTargets(
  ctx: EngineContext,
  draft: Draft<GameState>,
  source: CardInstance,
  targets: readonly CardInstanceId[],
  areas: readonly number[] = [],
): Result<Choices, RuleViolation> {
  const asking = askingAbilities(ctx, source, 'open');
  if (targets.length > asking.length) {
    return violation('ILLEGAL_TARGET', 'That card does not ask for that many targets.', '§13');
  }
  if (areas.length > asking.length) {
    return violation('ILLEGAL_TARGET', 'That card does not ask for that many areas.', '§13');
  }

  const cards: (CardInstanceId | undefined)[] = [];
  const chosenAreas: (number | undefined)[] = [];

  for (const [index, ability] of asking.entries()) {
    let picked: CardInstanceId | undefined;
    if (ability.target) {
      picked = targets[index];
      if (picked !== undefined) {
        const allowed = legalTargets(ctx, draft, source, ability.target, draft.battle);
        if (!allowed.some((card) => card.instanceId === picked)) {
          return violation('ILLEGAL_TARGET', 'That character cannot be targeted.', '§13');
        }
      }
      // Nothing chosen is a real outcome, not an error: the ability resolves
      // and finds nobody.
    }
    cards.push(picked);

    // The area, where the ability asks for one. Validated against the chosen
    // character where the kind is relative to one, because "adjacent" is
    // adjacent to *them* — see `areasFor`.
    if (ability.area === undefined || (ability.target !== undefined && picked === undefined)) {
      chosenAreas.push(undefined);
      continue;
    }
    const options = areasFor(ctx, draft, ability.area, source, picked);
    const area = areas[index] ?? (options.length === 1 ? options[0] : undefined);
    if (area === undefined) {
      // Nowhere to send them, or a choice the client did not make when there
      // was one. The move finds nowhere and does nothing.
      chosenAreas.push(undefined);
      continue;
    }
    if (!options.includes(area)) {
      return violation('ILLEGAL_TARGET', 'That is not a legal area for this card.', '§13');
    }
    chosenAreas.push(area);
  }

  return ok({ cards, areas: chosenAreas });
}

/** One ability's worth of chosen character and chosen area, in printed order. */
interface Choices {
  readonly cards: readonly (CardInstanceId | undefined)[];
  readonly areas: readonly (number | undefined)[];
}

/**
 * Uses a cost-bearing ability. Rules.md §13.
 *
 * The cost is paid before the effect resolves and is not refunded if the
 * effect finds nothing — that is what paying for something means. Everything
 * is validated here rather than trusted from the client, because `legalActions`
 * offering only legal uses is a convenience, not a guarantee.
 */
function useAbility(
  ctx: EngineContext,
  draft: Draft<GameState>,
  actor: PlayerId,
  action: Extract<GameAction, { type: 'USE_ABILITY' }>,
  events: GameEvent[],
): Result<true, RuleViolation> {
  const card = draft.cards[action.card];
  if (!card) return violation('CARD_NOT_IN_ZONE', 'No such card.', '§13');

  const entry = activatedAbilities(ctx, card as CardInstance).find(
    (candidate) => abilityKey(candidate.index) === action.ability,
  );
  if (!entry) return violation('ILLEGAL_TARGET', 'That card has no such ability.', '§13');
  if (!canActivate(ctx, draft as GameState, card as CardInstance, entry, actor)) {
    return violation('WRONG_PHASE', 'That ability cannot be used right now.', '§13');
  }

  const cost = entry.ability.cost;
  const pay = action.pay ?? [];
  const payCards: CardInstance[] = [];
  for (const id of pay) {
    const payCard = draft.cards[id];
    if (!payCard || payCard.zone !== 'hand' || payCard.controller !== actor) {
      return violation('CARD_NOT_IN_ZONE', 'Cost must be paid with cards from your hand.', '§13');
    }
    payCards.push(payCard as CardInstance);
  }
  const payment = validatePayment(ctx, activationCost(entry.ability), payCards);
  if (!payment.ok) return payment;

  // The chosen ally to lock comes first, ahead of any target for the effect:
  // a cost is settled before what it buys. Both are validated against the
  // same board the client saw.
  const choices = [...(action.targets ?? [])];
  let lockedAlly: CardInstanceId | undefined;
  if (cost?.lockAlly) {
    const picked = choices.shift();
    if (picked === undefined) {
      return violation('ILLEGAL_TARGET', 'That ability must lock one of your characters.', '§13');
    }
    const allowed = legalTargets(ctx, draft, card as CardInstance, cost.lockAlly, draft.battle);
    if (!allowed.some((option) => option.instanceId === picked)) {
      return violation('ILLEGAL_TARGET', 'That character cannot pay for this.', '§13');
    }
    lockedAlly = picked;
  }

  let doomedAlly: CardInstanceId | undefined;
  if (cost?.destroyAlly) {
    const picked = choices.shift();
    if (picked === undefined) {
      return violation(
        'ILLEGAL_TARGET',
        'That ability must destroy one of your characters.',
        '§13',
      );
    }
    const allowed = legalTargets(ctx, draft, card as CardInstance, cost.destroyAlly, draft.battle);
    if (!allowed.some((option) => option.instanceId === picked)) {
      return violation('ILLEGAL_TARGET', 'That character cannot pay for this.', '§13');
    }
    doomedAlly = picked;
  }

  let chosen: CardInstanceId | undefined;
  if (entry.ability.target) {
    const picked = choices.shift();
    if (picked === undefined) {
      return violation('ILLEGAL_TARGET', 'That ability must be pointed at somebody.', '§13');
    }
    const allowed = legalTargets(
      ctx,
      draft,
      card as CardInstance,
      entry.ability.target,
      draft.battle,
    );
    if (!allowed.some((option) => option.instanceId === picked)) {
      return violation('ILLEGAL_TARGET', 'That character cannot be targeted.', '§13');
    }
    chosen = picked;
  }
  if (choices.length > 0) {
    return violation('ILLEGAL_TARGET', 'That ability does not ask for that many choices.', '§13');
  }
  // The area, where the ability asks for one (BK1-131). Validated against the
  // chosen character where the kind is relative to one, exactly as the
  // on-open path does — never trusted from the client.
  let chosenArea: number | undefined;
  if (entry.ability.area !== undefined) {
    const options = areasFor(ctx, draft, entry.ability.area, card as CardInstance, chosen);
    const picked = action.areas?.[0] ?? (options.length === 1 ? options[0] : undefined);
    if (picked === undefined) {
      return violation('ILLEGAL_TARGET', 'That ability needs an area to aim at.', '§13');
    }
    if (!options.includes(picked)) {
      return violation('ILLEGAL_TARGET', 'That is not a legal area for this card.', '§13');
    }
    chosenArea = picked;
  }

  /* ------------------------------------------------------------ pay for it */

  for (const id of pay) {
    moveToZone(draft, id, { player: actor, zone: 'trash' });
    events.push({ type: 'CARD_TRASHED', player: actor, card: id });
  }
  if (pay.length > 0) events.push({ type: 'COST_PAID', player: actor, cards: [...pay] });

  if (cost?.lockSelf === true) card.locked = true;
  if (lockedAlly !== undefined) {
    const ally = draft.cards[lockedAlly];
    if (ally) ally.locked = true;
  }
  // The sacrificed character goes at once — unlike `destroySelf`, nothing
  // about it is needed to resolve the effect, so there is no stack to fizzle.
  if (doomedAlly !== undefined) {
    const ally = draft.cards[doomedAlly];
    if (ally) destroy(ctx, draft, ally, events);
  }
  if (cost?.oncePerTurn === true) {
    card.counters[usedOnTurnCounter(entry.index)] = turnOrdinal(draft);
  }

  events.push({ type: 'ABILITY_USED', player: actor, card: action.card, ability: action.ability });
  // Rules.md §14 — paid for, and now pending: both players may respond
  // before it resolves. A Quick ability used inside a window remembers that
  // window and returns to it once the stack has drained.
  const inWindow = draft.quick !== null;
  const pendingEffect: PendingEffect = {
    source: card.instanceId,
    controller: actor,
    ability: entry.index,
    ...(chosen !== undefined ? { chosen } : {}),
    // §14 resolves this later, so the area has to travel with it.
    ...(chosenArea !== undefined ? { area: chosenArea } : {}),
  };
  draft.stack = toDraft([...draft.stack, pendingEffect]);
  events.push({
    type: 'EFFECT_PENDING',
    player: actor,
    card: card.instanceId,
    text: entry.ability.text,
  });
  startRound(ctx, draft, events, inWindow ? resumeOf(draft) : null);
  return ok(true);
}

/**
 * BK2-043 and BK2-045's price, put one payment at a time. Rules.md §13.
 *
 * Three ways to pay, all of them the payer's own: a card out of hand, a Set
 * Card, or an open character. "Distributed any way" means each answer stands
 * on its own, so the question is repeated rather than asked once for all of
 * them. A player with nothing left to give simply pays nothing — §13 has the
 * effect resolve regardless.
 */
function askToPay(
  ctx: EngineContext,
  draft: Draft<GameState>,
  source: CardInstance,
  payer: PlayerId,
  owed: number,
  text: string,
  events: GameEvent[],
): boolean {
  if (owed <= 0) return false;
  const onField = Object.values(draft.cards)
    .filter((card) => card.zone === 'city' && card.controller === payer)
    // Their Set Cards and their open characters, which is what both lines
    // name; an open Effect card of theirs is neither.
    .filter((card) => !card.faceUp || isCharacter(ctx, card as CardInstance))
    .map((card) => card.instanceId);
  const inHand = [...(draft.zoneOrder[zoneKey(payer, 'hand')] ?? [])];
  if (onField.length === 0 && inHand.length === 0) return false;

  askFor(draft, events, {
    waitingOn: payer,
    source: source.instanceId,
    text,
    count: 1,
    upTo: false,
    kind: { zone: 'field', action: 'pay', cards: onField, hand: inHand },
    // The rest of the price follows behind this payment. `opponent` is read
    // from the *source card's* controller, as every effect's player is —
    // not from whoever is answering — so it keeps naming the same payer.
    ...(owed > 1
      ? { then: { effects: [{ do: 'theyPay', player: 'opponent', count: owed - 1 }] } }
      : {}),
  });
  return true;
}

/**
 * BK1-103's question, put for one character at a time. Rules.md §13.
 *
 * "Discard 2 cards for each character … or destroy that card" is a choice per
 * character, not one covering all of them, so each is asked in turn with the
 * remainder riding along as the continuation. Accepting pays the discard,
 * declining loses the character (`PendingChoice.orElse`), and either way the
 * next character is asked about behind it.
 *
 * A player who cannot pay is never asked: §13 resolves the effect regardless,
 * so the character is simply destroyed and the queue moves on.
 */
function askDestroyOrDiscard(
  ctx: EngineContext,
  draft: Draft<GameState>,
  source: CardInstance,
  victims: readonly CardInstanceId[],
  discard: number,
  text: string,
  events: GameEvent[],
): boolean {
  const before = events.length;
  let queue = victims;

  for (;;) {
    const [next, ...rest] = queue;
    if (next === undefined) return events.length > before;
    const card = draft.cards[next];
    // Already gone — a death rattle earlier in the queue may have taken it.
    if (!card || card.zone !== 'city') {
      queue = rest;
      continue;
    }
    if (handSize(draft, card.controller) < discard) {
      destroy(ctx, draft, card, events);
      queue = rest;
      continue;
    }
    const carryOn: Effect[] =
      rest.length > 0 ? [{ do: 'askDestroyOrDiscard', cards: rest, discard }] : [];
    askFor(draft, events, {
      waitingOn: card.controller,
      source: source.instanceId,
      text,
      count: 1,
      upTo: false,
      kind: { zone: 'decision' },
      // Accepting is agreeing to pay; declining gives up the character.
      then: { effects: [{ do: 'discard', player: 'you', count: discard }, ...carryOn] },
      orElse: { effects: [{ do: 'destroyOne', card: next }, ...carryOn] },
    });
    return true;
  }
}

/**
 * Fires every ability on `source` that answers to this trigger.
 *
 * Conditions are checked here rather than by the caller so that a trigger
 * with an unmet condition is a no-op rather than an omission — Rules.md §13
 * has cost-free abilities resolving "the moment the condition is met, even if
 * unfavorable to you", which means nobody gets to decide not to check.
 */
function fireAbilities(
  ctx: EngineContext,
  draft: Draft<GameState>,
  source: CardInstance,
  trigger: Trigger,
  events: GameEvent[],
  choices: Choices = { cards: [], areas: [] },
): void {
  let asked = 0;
  for (const ability of abilitiesOf(ctx, source)) {
    if (ability.trigger !== trigger) continue;
    const index = ability.target !== undefined || ability.area !== undefined ? asked++ : -1;
    const chosen = index >= 0 ? choices.cards[index] : undefined;
    const area = index >= 0 ? choices.areas[index] : undefined;
    if (!conditionHolds(ctx, draft, source, ability.condition, draft.battle)) continue;
    // An ability that asked for a target and got nobody has nothing to do,
    // and one that asked for an area and got nowhere likewise.
    if (ability.target && chosen === undefined) continue;
    if (ability.area && area === undefined) continue;
    resolveEffect(ctx, draft, source, ability, events, chosen, area);
  }
}

/**
 * Runs one ability: its effect, then anything chained after it. Rules.md §13.
 *
 * The printed line is announced once however many effects it carries, because
 * a card that does two things for one price said so in one sentence.
 */
function resolveEffect(
  ctx: EngineContext,
  draft: Draft<GameState>,
  source: CardInstance,
  ability: Ability,
  events: GameEvent[],
  chosen?: CardInstanceId | undefined,
  area?: number | undefined,
): void {
  events.push({
    type: 'ABILITY_RESOLVED',
    card: source.instanceId,
    player: source.controller,
    text: ability.text,
  });

  const did = runChain(
    ctx,
    draft,
    source,
    [ability.effect, ...(ability.then ?? [])],
    events,
    chosen,
    ability.text,
    area,
  );

  // Rules.md §13 resolves what it can, and sometimes that is nothing. Said
  // out loud, because a card that came forward and changed nothing otherwise
  // looks like a card that does not work. A line that stopped to ask has not
  // finished, and is not nothing.
  if (!did && !draft.pending) {
    events.push({
      type: 'ABILITY_FIZZLED',
      card: source.instanceId,
      player: source.controller,
      text: ability.text,
    });
  }
}

/**
 * Runs the effects of one printed line in order. Rules.md §13.
 *
 * An effect that stops to ask suspends the line: whatever follows it is
 * written onto the pending choice as its `then`, and `finishChoice` runs it
 * once the answer is in — "search your deck for a character … then draw 1
 * card" draws after the search, in printed order, however long the player
 * takes over the search.
 */
function runChain(
  ctx: EngineContext,
  draft: Draft<GameState>,
  source: CardInstance,
  effects: readonly Effect[],
  events: GameEvent[],
  chosen: CardInstanceId | undefined,
  text: string,
  area: number | undefined,
): boolean {
  let did = false;
  for (const [index, effect] of effects.entries()) {
    did = runEffect(ctx, draft, source, effect, events, chosen, text, area) || did;
    if (draft.pending) {
      const rest = effects.slice(index + 1);
      if (rest.length > 0) {
        const then: Continuation = {
          effects: rest,
          ...(chosen !== undefined ? { chosen } : {}),
          ...(area !== undefined ? { area } : {}),
        };
        draft.pending.then = toDraft(then);
      }
      return true;
    }
  }
  return did;
}

/**
 * One effect of one ability. Returns whether it changed anything — a boost
 * of nothing, a draw of nothing, a strike at nobody all answer no, so the
 * ability can say it found nothing to do.
 */
function runEffect(
  ctx: EngineContext,
  draft: Draft<GameState>,
  source: CardInstance,
  effect: Effect,
  events: GameEvent[],
  chosen?: CardInstanceId | undefined,
  /** The printed line, quoted back at the player if this effect has to ask. */
  text = '',
  /** The area the player chose, for an effect that asked for one. §13. */
  area?: number | undefined,
): boolean {
  const controller = source.controller;
  // Most effects say what they did by pushing events; "anything new since
  // we started" is the honest answer for those.
  const before = events.length;
  const pushed = (): boolean => events.length > before;

  switch (effect.do) {
    case 'buff': {
      // Counted before anything is written, so a "for each" reads the board
      // as it was when the ability resolved rather than as it becomes.
      const scale = scaleOf(ctx, draft, source, effect.per);
      const moved = Object.values(effect.stats).some((change) => change !== 0);
      // Under a trigger this is "until end of turn", so it is written onto
      // the card and cleared with damage in the End phase (Rules.md §10 ⑤).
      let touched = 0;
      for (const card of selected(ctx, draft, source, effect.who, chosen)) {
        touched++;
        for (const stat of ['power', 'hp', 'move'] as const) {
          const change = effect.stats[stat];
          if (change === undefined) continue;
          const key = counterFor(stat);
          card.counters[key] = (card.counters[key] ?? 0) + change * scale;
        }
      }
      return touched > 0 && scale > 0 && moved;
    }

    case 'draw': {
      const player = targetPlayer(draft, controller, effect.player, source);
      const count = effect.count * scaleOf(ctx, draft, source, effect.per);
      if (player && count > 0) drawInto(draft, player, count, events);
      return pushed();
    }

    case 'discard': {
      const player = targetPlayer(draft, controller, effect.player, source);
      if (!player) return false;
      // "If they have 3 or more cards in their hand" (BK1-104) — a gate on
      // the discard, not a number to discard down to.
      if (effect.ifHandAtLeast !== undefined && handSize(draft, player) < effect.ifHandAtLeast) {
        return false;
      }
      // Your opponent's cards go at random; your own are your choice. See the
      // note on the effect in `abilities.ts`, and `forcedDiscard` below.
      if (effect.player === 'opponent') {
        forcedDiscard(draft, player, effect.count, events);
        return pushed();
      }
      askFor(draft, events, {
        waitingOn: player,
        source: source.instanceId,
        text,
        // Never ask for more than the hand holds: a player owing two discards
        // from a hand of one would be stuck on a question with no answer.
        count: Math.min(effect.count, handSize(draft, player)),
        upTo: false,
        kind: { zone: 'hand', action: 'discard' },
      });
      return pushed();
    }

    case 'search': {
      const player = targetPlayer(draft, controller, effect.player);
      if (!player) return false;
      // A search that can find nothing does not stop to ask — the effect
      // resolves, finds nobody, and play carries on (Rules.md §13). The deck
      // is still shuffled, because the player has looked through it.
      const found = searchable(
        ctx,
        draft,
        player,
        effect.named,
        effect.characterOnly === true,
        effect.includeTrash === true,
        effect.topOfDeck,
      );
      if (found.length === 0) {
        // Same rule as `finishChoice`: a top-of-deck look is not a search, so
        // an empty one does not shuffle either.
        if (effect.topOfDeck === undefined) shuffleDeck(draft, player);
        return false;
      }
      const to = effect.to ?? 'hand';
      askFor(draft, events, {
        waitingOn: player,
        source: source.instanceId,
        text,
        count: Math.min(effect.count, found.length),
        upTo: effect.upTo === true,
        kind: {
          zone: 'deck',
          action:
            to === 'hand'
              ? 'toHand'
              : to === 'trash'
                ? 'toTrash'
                : to === 'setOpen'
                  ? 'toCityOpen'
                  : to === 'setAnywhere'
                    ? 'toCityAnywhere'
                    : 'toCity',
          named: effect.named,
          characterOnly: effect.characterOnly === true,
          ...(effect.includeTrash === true ? { includeTrash: true } : {}),
          ...(effect.topOfDeck !== undefined ? { topOfDeck: effect.topOfDeck } : {}),
          ...((to === 'set' || to === 'setOpen') && source.cityIndex !== undefined
            ? { city: source.cityIndex }
            : {}),
          reveal: effect.reveal === true,
        },
      });
      return pushed();
    }

    case 'revealUntilCharacter': {
      const city = source.cityIndex;
      if (city === undefined) return false;
      // Off the top, in deck order, until a character turns up. Nothing is
      // chosen, so this never stops to ask — unlike a search (§13).
      const deck = cardsInZone(draft as GameState, controller, 'deck');
      let found: Draft<CardInstance> | undefined;
      for (const card of deck) {
        events.push({ type: 'CARD_REVEALED', player: controller, card: card.instanceId });
        const live = draft.cards[card.instanceId];
        if (!live) continue;
        if (isCharacter(ctx, card)) {
          found = live;
          break;
        }
        // Everything turned over on the way is spent.
        moveToZone(draft, card.instanceId, { player: card.owner, zone: 'trash' });
        events.push({ type: 'CARD_TRASHED', player: controller, card: card.instanceId });
      }
      // A deck with no character left simply yields none; the cards turned
      // over are still spent, which is what the printed line does.
      if (!found) return pushed();

      moveToCity(draft, found.instanceId, city, { controller, faceUp: false });
      found.faceUp = true;
      found.counters[OPENED_ON_TURN] = turnOrdinal(draft);
      if (opensLocked(ctx, draft)) found.locked = true;
      events.push({ type: 'CARD_OPENED', player: controller, card: found.instanceId, city });
      // §11 ③ — it steps into the fight the destroyed character was in.
      if (effect.joinsBattle === true && draft.battle && draft.battle.city === city) {
        if (!draft.battle.participants.includes(found.instanceId)) {
          draft.battle.participants.push(found.instanceId);
        }
      }
      fireArrival(ctx, draft, found, events);
      fireAbilities(ctx, draft, found as CardInstance, 'open', events);
      refreshBoard(ctx, draft, events);
      return pushed();
    }

    case 'reorderTop': {
      const top = cardsInZone(draft as GameState, controller, 'deck').slice(0, effect.count);
      // Fewer than two cards is not a decision: there is only one order.
      if (top.length < 2) return false;
      askFor(draft, events, {
        waitingOn: controller,
        source: source.instanceId,
        text,
        count: top.length,
        upTo: false,
        kind: { zone: 'deckTop', action: 'reorder', cards: top.map((c) => c.instanceId) },
      });
      return pushed();
    }

    case 'setFromHand': {
      // "You may set … and immediately open it" (BK1-061). Nothing eligible in
      // hand is nothing to ask; otherwise the player picks one, or none.
      if (source.cityIndex === undefined) return false;
      const eligible = settable(ctx, draft as GameState, controller, effect.maxLevel);
      if (eligible.length === 0) return false;
      askFor(draft, events, {
        waitingOn: controller,
        source: source.instanceId,
        text,
        count: 1,
        upTo: true,
        kind: {
          zone: 'hand',
          action: 'setAndOpen',
          city: source.cityIndex,
          maxLevel: effect.maxLevel,
        },
      });
      return pushed();
    }

    case 'may': {
      // A yes or no. What follows a yes rides on the choice as its `then`.
      askFor(draft, events, {
        waitingOn: controller,
        source: source.instanceId,
        text,
        count: 1,
        upTo: false,
        kind: { zone: 'decision' },
        then: { effects: effect.effects, ...(chosen !== undefined ? { chosen } : {}) },
      });
      return pushed();
    }

    case 'skipDraw': {
      // Only the turn player's own Draw phase, and only before it has run:
      // the trigger that carries this fires at the start of the turn.
      if (draft.turn.activePlayer !== controller || draft.turn.drawSkipped) return false;
      draft.turn.drawSkipped = true;
      draft.turn.drawAtEnd += effect.atEnd;
      events.push({ type: 'DRAW_SKIPPED', player: controller });
      return true;
    }

    case 'attach': {
      const host = selected(ctx, draft, source, effect.who, chosen)[0];
      if (!host || host.instanceId === source.instanceId) return false;
      const wearer = draft.cards[source.instanceId];
      if (!wearer) return false;
      wearer.attachedTo = host.instanceId;
      // It stands where its host stands. `refreshBoard` keeps it there.
      if (host.cityIndex !== undefined) wearer.cityIndex = host.cityIndex;
      events.push({ type: 'CARD_ATTACHED', card: source.instanceId, to: host.instanceId });
      return true;
    }

    case 'unlock': {
      let freed = 0;
      for (const card of selected(ctx, draft, source, effect.who, chosen)) {
        if (card.locked) freed++;
        card.locked = false;
      }
      return freed > 0;
    }

    case 'reveal': {
      const seen = selected(ctx, draft, source, effect.who, chosen);
      if (seen.length === 0) return false;
      const watchers = effect.to === 'both' ? draft.seats : [controller];
      for (const watcher of watchers) {
        const already = draft.revealed[watcher] ?? [];
        const added = seen
          .map((card) => card.instanceId)
          .filter((id) => id !== undefined && !already.includes(id));
        draft.revealed[watcher] = toDraft([...already, ...added]);
      }
      for (const card of seen) {
        events.push({ type: 'CARD_REVEALED', player: controller, card: card.instanceId });
      }
      return pushed();
    }

    case 'lock': {
      let touched = 0;
      for (const card of selected(ctx, draft, source, effect.who, chosen)) {
        // Unconditional: a character already locked still takes the mark,
        // because BK1-085 is about the *next* Refresh and not about now.
        if (!card.locked) touched++;
        card.locked = true;
        if (effect.skipRefresh !== undefined && effect.skipRefresh > 0) {
          const owed = (card.counters[SKIP_REFRESH] ?? 0) + effect.skipRefresh;
          card.counters = { ...card.counters, [SKIP_REFRESH]: owed };
          touched++;
        }
      }
      return touched > 0;
    }

    case 'mill': {
      const player = targetPlayer(draft, controller, effect.player);
      if (!player) return false;
      // The top of the deck, unseen — `cardsInZone` is in deck order, and a
      // deck too short simply gives what it has. Running dry is not a loss
      // here: Rules.md §1 loses the match on the *draw*, not on this.
      const top = cardsInZone(draft as GameState, player, 'deck').slice(0, effect.count);
      for (const card of top) {
        moveToZone(draft, card.instanceId, { player: card.owner, zone: 'trash' });
        events.push({ type: 'CARD_TRASHED', player, card: card.instanceId });
      }
      return top.length > 0;
    }

    case 'returnToHand': {
      for (const card of selected(ctx, draft, source, effect.who, chosen)) {
        moveToZone(draft, card.instanceId, { player: card.owner, zone: 'hand' });
        events.push({ type: 'CARD_RETURNED', player: card.owner, card: card.instanceId });
      }
      return pushed();
    }

    case 'damage': {
      // Marked as damage rather than dealt as its own thing, so it stacks
      // with combat damage, kills at HP and clears at end of turn — the
      // three rules a separate kind of damage would have to repeat.
      // §13's "for each": a scale of nothing deals nothing, which is the
      // printed behaviour of a line counting an empty area.
      const scale = scaleOf(ctx, draft, source, effect.per);
      if (scale === 0) return false;
      for (const card of selected(ctx, draft, source, effect.who, chosen)) {
        if (hasWard(card as CardInstance)) {
          card.counters = { ...card.counters, [WARD]: (card.counters[WARD] ?? 0) - 1 };
          continue;
        }
        // Not combat: a card that only softens blows "during combat" says
        // nothing about a spell, and must not quietly absorb this.
        const amount = damageAfterReduction(
          ctx,
          draft,
          card as CardInstance,
          effect.amount * scale,
          { combat: false },
        );
        if (amount === 0) continue;
        card.damage += amount;
        events.push({
          type: 'DAMAGE_DEALT',
          source: source.instanceId,
          target: card.instanceId,
          amount,
          combat: false,
        });
      }
      // Checked after all of it lands, so an effect that hits several
      // characters kills them together rather than one at a time.
      for (const card of selected(ctx, draft, source, effect.who, chosen)) {
        if (card.damage >= hpOf(ctx, draft, card as CardInstance)) {
          destroy(ctx, draft, card, events);
        }
      }
      return pushed();
    }

    case 'destroy': {
      const doomed = selected(ctx, draft, source, effect.who, chosen);
      // Counted before anything is destroyed: "draw that many" means as many
      // as this line took off the board (BK1-152).
      const taken = doomed.length;
      for (const card of doomed) {
        destroy(ctx, draft, card, events);
      }
      if (effect.drawPerDestroyed === true && taken > 0) {
        drawInto(draft, controller, taken, events);
      }
      return pushed();
    }

    case 'negate': {
      let silenced = 0;
      for (const card of selected(ctx, draft, source, effect.who, chosen)) {
        // Not the card doing the silencing: it is a Normal Effect resolving
        // right now, and negating itself would undo the negation.
        if (card.instanceId === source.instanceId) continue;
        card.counters = { ...card.counters, [NEGATED]: 1 };
        silenced++;
      }
      return silenced > 0;
    }

    case 'discardDownTo': {
      // How many go depends on how many are held, so a hand already at or
      // under the size loses nothing (BK2-042).
      const players =
        effect.player === 'both'
          ? [...draft.seats]
          : [targetPlayer(draft, controller, effect.player, source)].filter(
              (seat): seat is PlayerId => seat !== null,
            );
      let took = 0;
      for (const seat of players) {
        const over = handSize(draft, seat) - effect.size;
        if (over <= 0) continue;
        // At random, like every other discard the holder does not choose:
        // "discard until" names a number, not the cards.
        forcedDiscard(draft, seat, over, events);
        took += over;
      }
      return took > 0;
    }

    case 'openLevelForTurn': {
      // Written onto the turn rather than read off the board: the card that
      // says it is a Normal Effect, gone to the Trash the moment it resolves.
      draft.turn.openLevelShift = (draft.turn.openLevelShift ?? 0) + effect.shift;
      return true;
    }

    case 'wardNextDamage': {
      let warded = 0;
      for (const card of selected(ctx, draft, source, effect.who, chosen)) {
        card.counters = { ...card.counters, [WARD]: (card.counters[WARD] ?? 0) + 1 };
        warded++;
      }
      return warded > 0;
    }

    // Continuous: read off the board by `rules.ts:subtypesOf`, never run.
    case 'grantSubtype':
      return true;

    case 'openedCardsLock':
      // Continuous, like `cannotAttack`: asked of the board where a card is
      // opened by `rules.ts:opensLocked`. Nothing to do when it resolves.
      return true;

    case 'seeCapital': {
      const capital = draft.cities.find((city) => city.royalCapital);
      if (!capital) return false;
      const already = draft.citiesSeen[controller] ?? [];
      if (already.includes(capital.index)) return false;
      draft.citiesSeen[controller] = toDraft([...already, capital.index]);
      return true;
    }

    case 'mark': {
      // The choice is made once and written down: an Eternal has to keep
      // answering for it long after the effect resolved (BK1-157).
      if (chosen === undefined) return false;
      const self = draft.cards[source.instanceId];
      if (!self) return false;
      self.marked = chosen;
      return true;
    }

    // Continuous by nature: read off the board by `cannotAttackArea` and by
    // the move rules. Nothing to do when they resolve.
    case 'markedCannotAttackHere':
    case 'markedDiesIfItLeaves':
      return true;

    case 'reflectDamage': {
      // Counters are numbers, so the protected side is stored as its seat
      // index plus one — 0 is "no reflection", which is what an absent
      // counter reads as.
      const seat = draft.seats.indexOf(controller);
      if (seat < 0) return false;
      let marked = 0;
      for (const card of selected(ctx, draft, source, effect.who, chosen)) {
        card.counters = { ...card.counters, [REFLECT]: seat + 1 };
        marked++;
      }
      return marked > 0;
    }

    case 'setTopOfDeck': {
      const to = effect.where === 'chosenArea' ? area : source.cityIndex;
      if (to === undefined || !draft.cities[to]) return false;
      const [top] = cardsInZone(draft as GameState, controller, 'deck');
      // An empty deck simply has nothing to set; running dry is a loss on the
      // *draw* (§1), not here.
      if (!top) return false;
      moveToCity(draft, top.instanceId, to, { controller, faceUp: false });
      events.push({ type: 'CARD_SET', player: controller, card: top.instanceId, city: to });
      return pushed();
    }

    case 'theyPay': {
      const payer = targetPlayer(draft, controller, effect.player, source);
      if (!payer) return false;
      return askToPay(ctx, draft, source, payer, effect.count, text, events);
    }

    case 'gatherHere': {
      const city = source.cityIndex;
      if (city === undefined) return false;
      const reachable = selected(ctx, draft, source, effect.who, chosen).filter(
        // Somebody already standing here has nowhere to be moved to.
        (card) => card.cityIndex !== city,
      );
      if (reachable.length === 0) return false;
      askFor(draft, events, {
        waitingOn: controller,
        source: source.instanceId,
        text,
        count: Math.min(effect.count, reachable.length),
        // "Any number": the count is a ceiling, and stopping early is legal.
        upTo: true,
        kind: {
          zone: 'field',
          action: 'moveHere',
          cards: reachable.map((card) => card.instanceId),
          city,
          ...(effect.unlock === true ? { unlock: true } : {}),
        },
      });
      return pushed();
    }

    case 'theyDestroy': {
      // The choice belongs to whoever owns the cards, not to the player who
      // used the ability (BK1-100). Nothing in reach is not an error — the
      // effect simply finds nobody, like any other.
      const reachable = selected(ctx, draft, source, effect.who, chosen);
      if (reachable.length === 0) return false;
      const owner = reachable[0]?.controller;
      if (!owner) return false;
      // One card, one owner: a selector reaching both sides would be asking
      // two players one question, which no card in the set does.
      const theirs = reachable.filter((card) => card.controller === owner);
      askFor(draft, events, {
        waitingOn: owner,
        source: source.instanceId,
        text,
        count: Math.min(effect.count, theirs.length),
        upTo: false,
        kind: {
          zone: 'field',
          action: 'destroy',
          cards: theirs.map((card) => card.instanceId),
        },
      });
      return pushed();
    }

    case 'destroyOrDiscard': {
      // BK1-103 — one question per character they have in the fight here,
      // asked one at a time because each answer is independent.
      const victims = selected(ctx, draft, source, effect.who, chosen)
        .map((card) => card.instanceId)
        .filter((id): id is CardInstanceId => id !== undefined);
      if (victims.length === 0) return false;
      return askDestroyOrDiscard(ctx, draft, source, victims, effect.discard, text, events);
    }

    case 'askDestroyOrDiscard':
      return askDestroyOrDiscard(ctx, draft, source, effect.cards, effect.discard, text, events);

    case 'destroyOne': {
      const victim = draft.cards[effect.card];
      if (!victim || victim.zone !== 'city') return false;
      destroy(ctx, draft, victim, events);
      return pushed();
    }

    case 'moveTo': {
      // Where they end up. "This area" is wherever the card doing the moving
      // stands — an ability whose own card has left the field has nowhere to
      // send anybody — and "an adjacent area" is the one the player picked,
      // already checked against the chosen character by `checkTargets`.
      const to = effect.where === 'chosenArea' ? area : source.cityIndex;
      if (to === undefined) return false;
      const travelling = selected(ctx, draft, source, effect.who, chosen);
      // "Move this and another character" — the source comes too (BK1-131).
      if (effect.withSource === true) {
        const self = draft.cards[source.instanceId];
        if (self && !travelling.some((card) => card.instanceId === self.instanceId)) {
          travelling.push(self);
        }
      }
      for (const card of travelling) {
        const from = card.cityIndex;
        if (from === undefined || from === to) continue;
        // Not locked and no Move spent: this is the effect moving them, not
        // the character taking their Main-phase move (Rules.md §10 ④(1), §14).
        card.cityIndex = to;
        if (card.faceUp) arrived(draft, card.controller, to);
        events.push({ type: 'CHARACTER_MOVED', card: card.instanceId, from, to });
        if (card.faceUp) {
          fireAbilities(ctx, draft, card as CardInstance, 'selfMoved', events);
          fireArrival(ctx, draft, card, events);
        }
      }
      // A city whose occupier has just walked away is no longer theirs
      // (Rules.md §12); `refreshBoard` runs after the action and settles it.
      return pushed();
    }

    case 'reduceDamage': {
      // Under a trigger this is a shield for the turn, written onto the card
      // and swept with the boosts. The continuous kind never reaches here —
      // it is read off the board by `damageReduction` as each blow lands.
      let shielded = 0;
      for (const card of selected(ctx, draft, source, effect.who, chosen)) {
        shielded++;
        card.counters[SHIELD] = (card.counters[SHIELD] ?? 0) + effect.amount;
      }
      return shielded > 0;
    }

    // Continuous by nature: asked of the board by `cannotAttack`, never run.
    // Continuous by nature: read off the board by `cannotAttack`, never run.
    case 'cannotAttack':
      return true;

    case 'openSetCard': {
      let opened = 0;
      for (const card of selected(ctx, draft, source, effect.who, chosen)) {
        if (card.faceUp || card.cityIndex === undefined) continue;
        card.faceUp = true;
        card.counters = { ...card.counters, [OPENED_ON_TURN]: turnOrdinal(draft) };
        if (isCharacter(ctx, card as CardInstance) && opensLocked(ctx, draft)) card.locked = true;
        events.push({
          type: 'CARD_OPENED',
          player: card.controller,
          card: card.instanceId,
          city: card.cityIndex,
        });
        fireArrival(ctx, draft, card, events);
        fireAbilities(ctx, draft, card as CardInstance, 'open', events);
        opened++;
      }
      if (opened > 0) refreshBoard(ctx, draft, events);
      return opened > 0;
    }

    case 'defenderBonus': {
      // One counter, however the printed line splits it: the set's only such
      // line grants +1/+1, so the two stats move together.
      const amount = effect.stats.power ?? effect.stats.hp ?? 0;
      if (amount === 0) return false;
      let granted = 0;
      for (const card of selected(ctx, draft, source, effect.who, chosen)) {
        card.counters = {
          ...card.counters,
          [REARGUARD]: (card.counters[REARGUARD] ?? 0) + amount,
        };
        granted++;
      }
      return granted > 0;
    }

    case 'seal': {
      let sealed = 0;
      for (const card of selected(ctx, draft, source, effect.who, chosen)) {
        card.counters = { ...card.counters, [SEALED]: 1 };
        sealed++;
      }
      return sealed > 0;
    }

    case 'cannotBattle': {
      // "Cannot participate in battle" for the rest of the turn, written onto
      // the card because the source is a Normal Effect and will be in the
      // Trash before anybody asks (§3).
      let marked = 0;
      for (const card of selected(ctx, draft, source, effect.who, chosen)) {
        card.counters = { ...card.counters, [NO_BATTLE]: 1 };
        marked++;
      }
      return marked > 0;
    }

    case 'openLevel':
    case 'captureDraw':
      // Continuous, like `cannotAttack`: read off the board by
      // `rules.ts:captureDrawFor` when a city changes hands. There is
      // nothing to do when it resolves.
      return true;
  }
}

/**
 * Sends a character to the Trash, firing whatever it has to say on the way.
 *
 * The order matters: `death` abilities are asked *before* the card leaves the
 * field, because an ability read off a card in the Trash is an ability read
 * off a card that is not there. Rules.md §3.
 */
function destroy(
  ctx: EngineContext,
  draft: Draft<GameState>,
  card: Draft<CardInstance>,
  events: GameEvent[],
): void {
  fireAbilities(ctx, draft, card as CardInstance, 'death', events);
  // Cards watching for an enemy to fall here (BK2-037), asked before it
  // leaves for the same reason `death` is: an ability read off the board is
  // read off cards that are on it.
  const fellIn = card.cityIndex;
  const fallen = card.controller;
  moveToZone(draft, card.instanceId, { player: card.owner, zone: 'trash' });
  events.push({ type: 'CHARACTER_DESTROYED', card: card.instanceId });
  if (fellIn !== undefined) fireEnemyDeath(ctx, draft, fallen, fellIn, events);
}

/** The cards on the field an effect's selector reaches, as drafts to write to. */
function selected(
  ctx: EngineContext,
  draft: Draft<GameState>,
  source: CardInstance,
  selector: Selector,
  chosen?: CardInstanceId | undefined,
): Draft<CardInstance>[] {
  return reachedBy(ctx, draft as GameState, source, selector, chosen, draft.battle)
    .map((card) => draft.cards[card.instanceId])
    .filter((card): card is Draft<CardInstance> => card !== undefined);
}

/**
 * How many cards a `per` selector counts. Rules.md §13's "for each".
 *
 * One is the multiplier when a card does not scale, so callers can apply this
 * unconditionally rather than branching around it.
 */
function scaleOf(
  ctx: EngineContext,
  draft: Draft<GameState>,
  source: CardInstance,
  per: Selector | undefined,
): number {
  if (!per) return 1;
  return selected(ctx, draft, source, per).length;
}

/**
 * Discards at random from a player's hand. Rules.md §13.
 *
 * Random because the *opponent* is the one losing cards and nobody has said
 * they get to choose — the cards in this set say "your opponent discards",
 * which is not the same as letting them pick their worst. A player discarding
 * their *own* cards picks them: to the hand limit through `DISCARD_CARD`
 * (§10 ⑤), and to an effect through `CHOOSE_CARD` (§13).
 */
function forcedDiscard(
  draft: Draft<GameState>,
  player: PlayerId,
  count: number,
  events: GameEvent[],
): void {
  for (let i = 0; i < count; i++) {
    const hand = draft.zoneOrder[zoneKey(player, 'hand')] ?? [];
    if (hand.length === 0) return;
    const { value: index, rng } = nextInt(draft.rng as Rng, hand.length);
    draft.rng = toDraft(rng);
    const cardId = hand[index];
    if (cardId === undefined) return;
    moveToZone(draft, cardId, { player, zone: 'trash' });
    events.push({ type: 'CARD_TRASHED', player, card: cardId });
  }
}

/* --------------------------------------------- effects that stop and ask */

/**
 * Suspends the game on a question. Rules.md §13, {@link PendingChoice}.
 *
 * A count of zero is not a question — a discard from an empty hand or a search
 * that found nothing has already resolved — so nothing is asked and play
 * carries on.
 */
function askFor(draft: Draft<GameState>, events: GameEvent[], choice: PendingChoice): void {
  if (choice.count <= 0) return;
  // Nothing is asked of a finished match. An earlier part of the same line can
  // end it — BK1-047 draws three before it discards two, and drawing from an
  // empty deck is a loss (§10 ②) — and a prompt over a match that is already
  // over would be a question with no legal answer, because `legalActions`
  // rightly offers nothing once the game is decided.
  if (draft.status.kind === 'finished') return;
  draft.pending = toDraft(choice);
  events.push({
    type: 'CHOICE_REQUIRED',
    player: choice.waitingOn,
    card: choice.source,
    text: choice.text,
    count: choice.count,
  });
}

/**
 * Shuffles a player's deck. Rules.md §13 — a deck that has been searched is
 * shuffled afterwards, or the searcher has learned the order of the rest.
 */
function shuffleDeck(draft: Draft<GameState>, player: PlayerId): void {
  const key = zoneKey(player, 'deck');
  const deck = draft.zoneOrder[key] ?? [];
  const shuffled = shuffle(deck as readonly CardInstanceId[], draft.rng as Rng);
  draft.zoneOrder[key] = toDraft(shuffled.items);
  draft.rng = toDraft(shuffled.rng);
}

/**
 * Answers the outstanding choice with one card. Rules.md §13.
 *
 * One card at a time: the choice counts down and asks again, so a player who
 * owes two discards names them one after the other rather than all at once.
 * The last answer closes the choice and the deck is shuffled if it was
 * searched — the search is over at that point, not before.
 */
function chooseCard(
  ctx: EngineContext,
  draft: Draft<GameState>,
  actor: PlayerId,
  cardId: CardInstanceId,
  events: GameEvent[],
  /** Where it goes, for a choice that lets the player say (BK1-155). */
  chosenCity?: number | undefined,
): Result<true, RuleViolation> {
  const pending = draft.pending;
  if (!pending) return violation('WRONG_PHASE', 'Nothing is waiting on a choice.', '§13');
  if (actor !== pending.waitingOn) {
    return violation('NOT_YOUR_PRIORITY', 'That choice is not yours to make.', '§13');
  }
  const kind = pending.kind;
  if (kind.zone === 'decision') {
    return violation('WRONG_PHASE', 'That is a yes or no, not a card.', '§13');
  }

  const card = draft.cards[cardId];
  // The zone a choice *asks about* is not always the zone its cards are in:
  // a field choice names cards standing in a city, and a deck-top reorder
  // names cards that are still in the deck.
  const wantedZone = kind.zone === 'field' ? 'city' : kind.zone === 'deckTop' ? 'deck' : kind.zone;
  // A search that reaches the Trash as well (BK1-115) accepts either zone;
  // `searchable` below is what says the card was really on offer.
  const searchingTrash = kind.zone === 'deck' && kind.includeTrash === true;
  // A price may be paid out of hand as well as off the field (BK2-043).
  const payingFromHand = kind.zone === 'field' && kind.action === 'pay' && card?.zone === 'hand';
  const inZone =
    card?.zone === wantedZone || (searchingTrash && card?.zone === 'trash') || payingFromHand;
  if (!card || card.controller !== actor || !inZone) {
    return violation('CARD_NOT_IN_ZONE', `That card is not in your ${kind.zone}.`, '§13');
  }

  if (kind.zone === 'field') {
    // Exactly what was offered when the question was posed — never re-derived
    // from a selector against a board that has since moved.
    if (!kind.cards.includes(cardId) && !(kind.hand ?? []).includes(cardId)) {
      return violation('ILLEGAL_TARGET', 'That card was not offered.', '§13');
    }
    if (kind.action === 'moveHere') {
      const to = kind.city;
      if (to === undefined) return violation('WRONG_PHASE', 'Nowhere to move it to.', '§13');
      const from = card.cityIndex;
      card.cityIndex = to;
      // §14 over §6: an effect saying where somebody ends up spends no Move
      // and locks nobody, so the printed unlock is a real grant.
      if (kind.unlock === true) card.locked = false;
      if (from !== undefined) {
        events.push({ type: 'CHARACTER_MOVED', card: cardId, from, to });
      }
      if (card.faceUp) {
        arrived(draft, card.controller, to);
        fireArrival(ctx, draft, card, events);
      }
      // Struck off, so each card is named once.
      pending.kind = toDraft({ ...kind, cards: kind.cards.filter((id) => id !== cardId) });
    } else {
      destroy(ctx, draft, card, events);
    }
  } else if (kind.zone === 'hand' && kind.action === 'discard') {
    moveToZone(draft, cardId, { player: actor, zone: 'trash' });
    events.push({ type: 'CARD_TRASHED', player: actor, card: cardId });
  } else if (kind.zone === 'hand') {
    // Set and open at once, paying nothing (BK1-061). The level ceiling is
    // re-checked here rather than trusted from the client.
    const eligible = settable(ctx, draft as GameState, actor, kind.maxLevel);
    if (!eligible.some((c) => c.instanceId === cardId)) {
      return violation('ILLEGAL_TARGET', 'That card cannot be set by this effect.', '§13');
    }
    moveToCity(draft, cardId, kind.city, { controller: actor, faceUp: false });
    events.push({ type: 'CARD_SET', player: actor, card: cardId, city: kind.city });
    card.faceUp = true;
    card.counters[OPENED_ON_TURN] = turnOrdinal(draft);
    if (isCharacter(ctx, card as CardInstance) && opensLocked(ctx, draft)) card.locked = true;
    events.push({ type: 'CARD_OPENED', player: actor, card: cardId, city: kind.city });
    fireArrival(ctx, draft, card, events);
    // The card's own on-open abilities fire, with nothing chosen for them:
    // the effect said "open it", not "open it and point it at somebody".
    fireAbilities(ctx, draft, card as CardInstance, 'open', events);
    refreshBoard(ctx, draft, events);
  } else if (kind.zone === 'deckTop') {
    // Naming a card puts it back on top, so the last one named is drawn
    // next (BK1-159). Nothing leaves the deck and nothing is shuffled.
    if (!kind.cards.includes(cardId)) {
      return violation('ILLEGAL_TARGET', 'That card was not offered.', '§13');
    }
    const key = zoneKey(actor, 'deck');
    const order = (draft.zoneOrder[key] ?? []).filter((id) => id !== cardId);
    draft.zoneOrder[key] = toDraft([cardId, ...order]);
    // Struck off the list still to be named, so each is placed once.
    pending.kind = toDraft({
      ...kind,
      cards: kind.cards.filter((id) => id !== cardId),
    });
  } else {
    // The restrictions are re-checked here rather than trusted from the
    // client: `legalActions` only offers matching cards, and `reduce` never
    // takes that on faith.
    const def = definitionOf(ctx, card as CardInstance);
    if (kind.named !== null && def.name !== kind.named) {
      return violation('ILLEGAL_TARGET', `That card is not a ${kind.named}.`, '§13');
    }
    if (kind.characterOnly && !isCharacter(ctx, card as CardInstance)) {
      return violation('ILLEGAL_TARGET', 'That card is not a character.', '§13');
    }
    if (kind.reveal) events.push({ type: 'CARD_REVEALED', player: actor, card: cardId });
    if (kind.action === 'toHand') {
      moveToZone(draft, cardId, { player: actor, zone: 'hand' });
      events.push({ type: 'DECK_SEARCHED', player: actor, card: cardId });
    } else if (kind.action === 'toTrash') {
      moveToZone(draft, cardId, { player: actor, zone: 'trash' });
      events.push({ type: 'DECK_SEARCHED', player: actor, card: cardId });
      events.push({ type: 'CARD_TRASHED', player: actor, card: cardId });
    } else {
      // "Set them anywhere" lets the player name the city; every other
      // destination is fixed by the printed line to the source's own area.
      const city = kind.action === 'toCityAnywhere' ? chosenCity : kind.city;
      if (city === undefined) return violation('WRONG_PHASE', 'Nowhere to set that card.', '§13');
      if (kind.action === 'toCityAnywhere' && !draft.cities[city]) {
        return violation('ILLEGAL_TARGET', 'That is not a city.', '§13');
      }
      moveToCity(draft, cardId, city, { controller: actor, faceUp: false });
      events.push({ type: 'DECK_SEARCHED', player: actor, card: cardId });
      events.push({ type: 'CARD_SET', player: actor, card: cardId, city });
      if (kind.action === 'toCityOpen') {
        // "Set that card in this area, and then open it" (BK1-091) — free and
        // outside the City Level gate, as with BK1-061: the printed line is
        // what puts it there, not the turn's one open (§10 ③).
        card.faceUp = true;
        card.counters[OPENED_ON_TURN] = turnOrdinal(draft);
        if (isCharacter(ctx, card as CardInstance) && opensLocked(ctx, draft)) card.locked = true;
        events.push({ type: 'CARD_OPENED', player: actor, card: cardId, city });
        fireArrival(ctx, draft, card, events);
        fireAbilities(ctx, draft, card as CardInstance, 'open', events);
        refreshBoard(ctx, draft, events);
      }
    }
  }

  const left = pending.count - 1;
  // The choice goes on while cards are owed *and* there is anything left to
  // choose from — a search for two Mercenaries with one in the deck ends when
  // that one is taken, rather than waiting on a question with no answer.
  const remaining = legalActions(ctx, draft as GameState, actor).some(
    (action) => action.type === 'CHOOSE_CARD',
  );
  if (left > 0 && remaining) {
    pending.count = left;
    events.push({
      type: 'CHOICE_REQUIRED',
      player: pending.waitingOn,
      card: pending.source,
      text: pending.text,
      count: left,
    });
    return ok(true);
  }

  finishChoice(ctx, draft, events);
  return ok(true);
}

/**
 * A yes or a no, or "that will do". Rules.md §13, `ANSWER`.
 *
 * On a decision, yes runs what the line said follows and no drops it. On an
 * "up to" choice, no ends the choice where it stands; yes is not an answer
 * to a question that was not asked.
 */
function answer(
  ctx: EngineContext,
  draft: Draft<GameState>,
  actor: PlayerId,
  accept: boolean,
  events: GameEvent[],
): Result<true, RuleViolation> {
  const pending = draft.pending;
  if (!pending) return violation('WRONG_PHASE', 'Nothing is waiting on an answer.', '§13');
  if (actor !== pending.waitingOn) {
    return violation('NOT_YOUR_PRIORITY', 'That choice is not yours to make.', '§13');
  }
  if (pending.kind.zone === 'decision') {
    // A declined "you may" simply does nothing; a declined either/or runs its
    // other branch instead (BK1-103). See `PendingChoice.orElse`.
    if (!accept) {
      if (pending.orElse) pending.then = pending.orElse;
      else delete pending.then;
    }
    delete pending.orElse;
    finishChoice(ctx, draft, events);
    return ok(true);
  }
  if (!pending.upTo) {
    return violation('WRONG_PHASE', 'That choice has to be made in full.', '§13');
  }
  if (accept) return violation('WRONG_PHASE', 'Choose a card, or stop.', '§13');
  finishChoice(ctx, draft, events);
  return ok(true);
}

/**
 * Closes the outstanding choice: shuffles a searched deck (the search is
 * over at that point, not before) and runs whatever the printed line still
 * had to say — which may stop to ask again, and then this is called again.
 */
function finishChoice(ctx: EngineContext, draft: Draft<GameState>, events: GameEvent[]): void {
  const pending = draft.pending;
  if (!pending) return;
  // A "look at the top n" is not a search: the player has seen only what the
  // card let them see, and the order of the rest is already unknown to them.
  // BK1-159 says "do not shuffle" outright, and §13's shuffle exists to stop
  // a searcher keeping what they learned looking through the whole deck.
  const searched = pending.kind.zone === 'deck' && pending.kind.topOfDeck === undefined;
  const player = pending.waitingOn;
  const rest = pending.then;
  const source = draft.cards[pending.source];
  const text = pending.text;
  draft.pending = null;
  if (searched) shuffleDeck(draft, player);
  if (rest && source) {
    runChain(
      ctx,
      draft,
      source as CardInstance,
      rest.effects,
      events,
      rest.chosen,
      text,
      rest.area,
    );
  } // The choice may have come out of an effect resolving off the stack
  // (Rules.md §14); whatever is still pending there gets its round now, and
  // the window the round interrupted comes back once it has drained.
  if (!draft.pending && (draft.stack.length > 0 || draft.resume)) {
    startRound(ctx, draft, events, draft.resume);
  }
}

/** Notes a character arriving in a city this turn, for cards that ask. */
function arrived(draft: Draft<GameState>, player: PlayerId, city: number): void {
  draft.turn.arrivals = toDraft([...draft.turn.arrivals, { player, city }]);
}

/**
 * Fires `enemyDeathHere` for everything standing where a character just
 * fell, on the *other* side from the one that died. Rules.md §3.
 *
 * Run after the body has gone to the Trash, so a watcher that also died in
 * the same blow is no longer on the field to answer — the board it reads is
 * the board as it now stands.
 */
function fireEnemyDeath(
  ctx: EngineContext,
  draft: Draft<GameState>,
  fallen: PlayerId,
  city: number,
  events: GameEvent[],
): void {
  for (const watcher of Object.values(draft.cards)) {
    if (watcher.zone !== 'city' || !watcher.faceUp) continue;
    if (watcher.cityIndex !== city) continue;
    // "Whenever an *enemy* character dies" — read from the watcher's side.
    if (watcher.controller === fallen) continue;
    for (const ability of abilitiesOf(ctx, watcher as CardInstance)) {
      if (ability.trigger !== 'enemyDeathHere') continue;
      if (!conditionHolds(ctx, draft, watcher as CardInstance, ability.condition, draft.battle)) {
        continue;
      }
      resolveEffect(ctx, draft, watcher as CardInstance, ability, events);
    }
  }
}

/**
 * Fires the `enemyCapture` trigger for everything the capturing player does
 * *not* control. Rules.md §12.
 *
 * The captured city travels as the chosen area, so an effect can act on the
 * ground that just changed hands rather than on wherever its own card
 * happens to be standing.
 */
function fireEnemyCapture(
  ctx: EngineContext,
  draft: Draft<GameState>,
  captor: PlayerId,
  city: number,
  events: GameEvent[],
): void {
  for (const watcher of Object.values(draft.cards)) {
    if (watcher.zone !== 'city' || !watcher.faceUp) continue;
    // Two mirrored triggers: one answers to the other player taking ground,
    // the other to your own (§12).
    const want = watcher.controller === captor ? 'ownCapture' : 'enemyCapture';
    for (const ability of abilitiesOf(ctx, watcher as CardInstance)) {
      if (ability.trigger !== want) continue;
      if (!conditionHolds(ctx, draft, watcher as CardInstance, ability.condition, draft.battle)) {
        continue;
      }
      resolveEffect(ctx, draft, watcher as CardInstance, ability, events, undefined, city);
    }
  }
}

/**
 * Fires the `arrival` trigger of everything standing in a city, on behalf of
 * a character that has just turned up there. Rules.md §13.
 *
 * Called from both ways in — opening a card face up (§7) and moving one
 * (§10 ④(1)) — because BK1-113 names them together and a hook on only one of
 * them would be a card that works half the time. The newcomer travels as the
 * chosen card, so an ability reaches it with `{ scope: 'target' }`.
 */
function fireArrival(
  ctx: EngineContext,
  draft: Draft<GameState>,
  newcomer: Draft<CardInstance>,
  events: GameEvent[],
): void {
  if (newcomer.cityIndex === undefined) return;
  if (!isCharacter(ctx, newcomer as CardInstance)) return;
  for (const watcher of Object.values(draft.cards)) {
    if (watcher.zone !== 'city' || !watcher.faceUp) continue;
    if (watcher.cityIndex !== newcomer.cityIndex) continue;
    if (watcher.instanceId === newcomer.instanceId) continue;
    for (const ability of abilitiesOf(ctx, watcher as CardInstance)) {
      if (ability.trigger !== 'arrival') continue;
      if (
        !conditionHolds(
          ctx,
          draft,
          watcher as CardInstance,
          ability.condition,
          draft.battle,
          newcomer.instanceId,
        )
      ) {
        continue;
      }
      resolveEffect(ctx, draft, watcher as CardInstance, ability, events, newcomer.instanceId);
    }
  }
}

/** Every face-up card on the field, so turn triggers can sweep the board. */
function faceUpOnField(draft: Draft<GameState>): Draft<CardInstance>[] {
  return Object.values(draft.cards).filter((card) => card.zone === 'city' && card.faceUp);
}

/**
 * Runs a turn-edge trigger across the board. Rules.md §13.
 *
 * Most such abilities are written from their controller's side ("at the start
 * of your turn") and so only fire on that player's turn. A card that says
 * "the turn" instead fires on either, which matters because a defender can
 * open during a battle on the attacker's turn (§11 ②) — a card that came down
 * then should go home at the end of *that* turn, not wait for its own.
 */
function fireTurnTrigger(
  ctx: EngineContext,
  draft: Draft<GameState>,
  player: PlayerId,
  trigger: Trigger,
  events: GameEvent[],
): void {
  for (const card of faceUpOnField(draft)) {
    for (const ability of abilitiesOf(ctx, card as CardInstance)) {
      if (ability.trigger !== trigger) continue;
      // "Your turn" is the default; a card that says "the turn" answers to
      // both. See `Ability.turns`.
      if ((ability.turns ?? 'yours') === 'yours' && card.controller !== player) continue;
      if (!conditionHolds(ctx, draft, card as CardInstance, ability.condition, draft.battle)) {
        continue;
      }
      resolveEffect(ctx, draft, card as CardInstance, ability, events);
    }
  }
}
