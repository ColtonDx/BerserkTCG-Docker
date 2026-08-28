import { beforeEach, describe, expect, it } from 'vitest';
import { catalogueRegistry } from './data/registry.js';
import { createEngine, type Engine } from './engine.js';
import { asCardDefId, asMatchId, asPlayerId, type CardInstanceId, type PlayerId } from './ids.js';
import type { CardInstance, GameAction, GameState, QuickTrigger } from './types.js';

/**
 * Quick windows. Rules.md §13, DesignNotes "When to offer a Quick".
 *
 * The rule being tested is a narrowing, not the rulebook: §13 would let a
 * Quick interject almost anywhere, and asking after every action makes the
 * game a dialogue box. So what matters here is as much *when it stays quiet*
 * as when it asks.
 */

const ALICE = asPlayerId('alice');
const BOB = asPlayerId('bob');

// BK1-024 Foolish Banditry: Quick, Level 1, one white icon.
const QUICK = 'BK1-024';
// BK1-002 Bold Siege Squadron: not Quick, same Level and cost.
const SLOW = 'BK1-002';

const registry = catalogueRegistry();
let engine: Engine;

beforeEach(() => {
  engine = createEngine(registry);
});

const deckOf = (defId: string, count = 45): string[] => Array.from({ length: count }, () => defId);

function started(): GameState {
  const match = engine.createMatch({
    matchId: asMatchId('quick'),
    seed: 5,
    decks: [
      { playerId: ALICE, name: 'Alice', cards: deckOf('BK1-001').map(asCardDefId) },
      { playerId: BOB, name: 'Bob', cards: deckOf('BK1-001').map(asCardDefId) },
    ],
  });
  const result = engine.reduceAll(match, [
    { actor: ALICE, action: { type: 'KEEP_HAND' } },
    { actor: BOB, action: { type: 'KEEP_HAND' } },
  ]);
  if (!result.ok) throw new Error(`setup failed: ${result.error.message}`);
  return result.value.state;
}

function apply(state: GameState, actor: PlayerId, action: GameAction): GameState {
  const result = engine.reduce(state, actor, action);
  if (!result.ok) throw new Error(`${action.type} rejected: ${result.error.message}`);
  return result.value.state;
}

/** Sets a card face-down in a city for a player, taking it out of their hand. */
function set(
  state: GameState,
  player: PlayerId,
  defId: string,
  city = 2,
): { state: GameState; card: CardInstanceId } {
  const spare = Object.values(state.cards).find(
    (card) => card.controller === player && card.zone === 'hand',
  );
  if (!spare) throw new Error('no card left in hand');
  const placed: CardInstance = {
    ...spare,
    defId: asCardDefId(defId),
    zone: 'city',
    cityIndex: city,
    faceUp: false,
    locked: false,
    damage: 0,
  };
  return {
    state: { ...state, cards: { ...state.cards, [spare.instanceId]: placed } },
    card: spare.instanceId,
  };
}

/** A city face-up so Level 1 cards can be opened, and a payable hand. */
const withLevel = (state: GameState, level = 1): GameState => ({
  ...state,
  cities: state.cities.map((city, index) => (index < level ? { ...city, faceUp: true } : city)),
});

/** The board a window is tested from: a Quick set for the waiting player. */
function armed(defId = QUICK): { state: GameState; active: PlayerId; waiting: PlayerId } {
  let state = withLevel(started());
  const active = state.turn.activePlayer;
  const waiting = state.seats.find((seat) => seat !== active) as PlayerId;
  state = set(state, waiting, defId).state;
  return { state, active, waiting };
}

const windowOf = (state: GameState): QuickTrigger | null => state.quick?.trigger ?? null;

describe('Quick windows (Rules.md §13)', () => {
  it('asks the other player when a turn starts', () => {
    // Armed the other way round: it is the player whose turn is *not*
    // starting who gets asked, so the Quick has to be theirs.
    let state = withLevel(started());
    const active = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== active) as PlayerId;
    state = set(state, active, QUICK).state;

    const next = runOut(state, active);
    expect(next.turn.activePlayer).toBe(other);
    expect(windowOf(next)).toBe('turnStart');
    expect(next.quick?.waitingOn).toBe(active);
  });

  it('asks when the opponent opens a card', () => {
    let { state, active, waiting } = armed();
    const theirs = set(state, active, SLOW);
    state = atPhase(theirs.state, 'open');

    const open = engine
      .legalActions(state, active)
      .find((action) => action.type === 'OPEN_CARD' && action.card === theirs.card);
    expect(open, 'the opponent should be able to open').toBeDefined();
    state = apply(state, active, open as GameAction);

    expect(state.quick?.waitingOn).toBe(waiting);
    expect(windowOf(state)).toBe('cardOpened');
  });

  it('asks when the opponent reaches Main, and again at the End phase', () => {
    const { state, active, waiting } = armed();
    let next = atPhase(state, 'open');
    next = apply(next, active, { type: 'END_PHASE' });
    expect(next.quick?.waitingOn).toBe(waiting);
    expect(windowOf(next)).toBe('mainPhase');

    next = apply(next, waiting, { type: 'PASS_PRIORITY' });
    next = apply(next, active, { type: 'END_PHASE' });
    expect(windowOf(next)).toBe('turnEnd');
  });

  it('asks the defender when a battle is declared, and again at the attack', () => {
    let { state, active, waiting } = armed();
    // Somebody to attack with, and somebody to attack.
    state = faceUp(state, active, 'BK1-001', 2);
    state = faceUp(state, waiting, 'BK1-001', 2);
    state = atPhase(state, 'main');

    state = apply(state, active, { type: 'DECLARE_BATTLE', city: 2 });
    expect(state.quick?.waitingOn).toBe(waiting);
    expect(windowOf(state)).toBe('combat');

    state = apply(state, waiting, { type: 'PASS_PRIORITY' });
    const lead = Object.values(state.cards).find(
      (card) => card.controller === active && card.zone === 'city' && card.faceUp,
    ) as CardInstance;
    state = apply(state, active, { type: 'DESIGNATE_VANGUARD', card: lead.instanceId });
    expect(windowOf(state)).toBe('attack');
  });

  it('stays quiet when the player has no Quick set', () => {
    // The same moments, with an ordinary card set instead: nothing is asked,
    // which is what makes a prompt mean something when it does come.
    const { state, active } = armed(SLOW);
    const next = runOut(state, active);
    expect(next.quick).toBeNull();
  });

  it('stays quiet when the Quick cannot be paid for', () => {
    // Rules.md §13 — Quick frees the timing, not the cost. An empty hand
    // cannot pay, so there is nothing to ask about.
    const { state, active, waiting } = armed();
    const emptied: GameState = {
      ...state,
      zoneOrder: { ...state.zoneOrder, [`${waiting}:hand`]: [] },
    };
    expect(runOut(emptied, active).quick).toBeNull();
  });

  it('stays quiet when City Level is too low to open it', () => {
    const { state, active } = armed();
    const dark: GameState = {
      ...state,
      cities: state.cities.map((city) => ({ ...city, faceUp: false })),
    };
    expect(runOut(dark, active).quick).toBeNull();
  });
});

describe('answering a Quick window', () => {
  it('freezes the game until it is answered', () => {
    const { state, active, waiting } = armed();
    const asked = runOut(state, active);
    expect(asked.quick).not.toBeNull();

    // The other player cannot carry on, whoever's turn it is.
    const barged = engine.reduce(asked, asked.turn.activePlayer, { type: 'END_PHASE' });
    expect(barged.ok).toBe(false);
    if (!barged.ok) expect(barged.error.code).toBe('NOT_YOUR_PRIORITY');

    // And the one being asked may only open a Quick or pass.
    const kinds = new Set(
      engine.legalActions(asked, asked.quick?.waitingOn as PlayerId).map((a) => a.type),
    );
    expect([...kinds].sort()).toEqual(['CONCEDE', 'OPEN_CARD', 'PASS_PRIORITY']);
    expect(waiting === active).toBe(false);
  });

  it('lets play carry on when it is declined', () => {
    const { state, active } = armed();
    const asked = runOut(state, active);
    const waiting = asked.quick?.waitingOn as PlayerId;

    const next = apply(asked, waiting, { type: 'PASS_PRIORITY' });
    expect(next.quick).toBeNull();
    // The turn it interrupted has resumed and rested somewhere playable.
    expect(engine.legalActions(next, next.turn.priorityPlayer).length).toBeGreaterThan(1);
  });

  it('opens the Quick out of phase without spending the turn’s open', () => {
    let { state, active, waiting } = armed();
    state = atPhase(state, 'open');
    state = apply(state, active, { type: 'END_PHASE' });
    expect(windowOf(state)).toBe('mainPhase');

    const open = engine.legalActions(state, waiting).find((action) => action.type === 'OPEN_CARD');
    expect(open, 'the Quick should be offered').toBeDefined();

    const before = state.turn.openedThisTurn;
    state = apply(state, waiting, open as GameAction);
    // It is not their turn, so the turn player's one open is untouched.
    expect(state.turn.openedThisTurn).toBe(before);
    expect(state.turn.activePlayer).toBe(active);
  });

  it('refuses a card that is not Quick', () => {
    let { state, active, waiting } = armed();
    const slow = set(state, waiting, SLOW, 3);
    state = atPhase(slow.state, 'open');
    state = apply(state, active, { type: 'END_PHASE' });
    expect(state.quick).not.toBeNull();

    const sneaky = engine.reduce(state, waiting, {
      type: 'OPEN_CARD',
      card: slow.card,
      pay: payableWith(state, waiting),
    });
    expect(sneaky.ok).toBe(false);
    if (!sneaky.ok) expect(sneaky.error.rule).toBe('§13');
  });

  it('refuses PASS_PRIORITY when nothing is being asked', () => {
    const { state, active } = armed(SLOW);
    const idle = engine.reduce(state, active, { type: 'PASS_PRIORITY' });
    expect(idle.ok).toBe(false);
  });
});

describe('what a window offers (DesignNotes "When to offer a Quick")', () => {
  // BK1-026 Negotiate By Force: Quick, "+1/+1 until end of turn" — worth
  // nothing with no battle to spend it in. Rules.md §13 would let it be
  // opened anyway; the game does not stop to ask.
  const BUFF = 'BK1-026';

  it('stays quiet at the turn edges for a Quick that only matters in a fight', () => {
    let state = withLevel(started());
    const active = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== active) as PlayerId;
    // Somebody for the buff to land on, so it is not nobody that keeps it quiet.
    state = faceUp(state, other, 'BK1-001', 2);
    state = set(state, other, BUFF).state;

    expect(runOut(state, active).quick).toBeNull();
  });

  it('refuses a Quick the window did not offer', () => {
    // The window opens for the draw; the buff is set beside it and is not
    // worth anything here. `legalActions` leaves it out, so `reduce` must too.
    let state = withLevel(started());
    const active = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== active) as PlayerId;
    state = faceUp(state, other, 'BK1-001', 2);
    state = set(state, other, QUICK).state;
    const buff = set(state, other, BUFF, 2);
    state = atPhase(buff.state, 'open');
    state = apply(state, active, { type: 'END_PHASE' });
    expect(windowOf(state)).toBe('mainPhase');

    const offered = engine
      .legalActions(state, other)
      .filter((action) => action.type === 'OPEN_CARD')
      .map((action) => (action as Extract<GameAction, { type: 'OPEN_CARD' }>).card);
    expect(offered).not.toContain(buff.card);

    const sneaky = engine.reduce(state, other, {
      type: 'OPEN_CARD',
      card: buff.card,
      pay: payableWith(state, other),
    });
    expect(sneaky.ok).toBe(false);
    if (!sneaky.ok) expect(sneaky.error.rule).toBe('§13');
  });

  it('asks before damage — the attacker first, then the defender', () => {
    let state = withLevel(started());
    const active = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== active) as PlayerId;
    state = faceUp(state, active, 'BK1-001', 2);
    state = faceUp(state, other, 'BK1-001', 2);
    // Both hold a combat Quick in the contested area.
    state = set(state, active, BUFF).state;
    state = set(state, other, BUFF).state;
    state = atPhase(state, 'main');

    state = apply(state, active, { type: 'DECLARE_BATTLE', city: 2 });
    state = declineWindows(state);
    const lead = standing(state, active);
    state = apply(state, active, { type: 'DESIGNATE_VANGUARD', card: lead });
    state = declineWindows(state);
    // Neither side takes the combat open (§11 ②); the defender joins (§11 ③).
    state = untilStep(state, 'commit');
    state = apply(state, other, { type: 'COMMIT_CHARACTER', card: standing(state, other) });

    expect(windowOf(state)).toBe('beforeDamage');
    expect(state.quick?.waitingOn).toBe(active);
    expect(state.quick?.then).toBe(other);

    state = apply(state, active, { type: 'PASS_PRIORITY' });
    expect(windowOf(state)).toBe('beforeDamage');
    expect(state.quick?.waitingOn).toBe(other);

    state = apply(state, other, { type: 'PASS_PRIORITY' });
    expect(state.quick).toBeNull();
    expect(state.battle).toBeNull();
  });

  it('spends a combat Quick opened before damage on the blows that follow', () => {
    let state = withLevel(started());
    const active = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== active) as PlayerId;
    state = faceUp(state, active, 'BK1-001', 2);
    state = faceUp(state, other, 'BK1-001', 2);
    const buff = set(state, active, BUFF);
    state = atPhase(buff.state, 'main');

    state = apply(state, active, { type: 'DECLARE_BATTLE', city: 2 });
    const lead = standing(state, active);
    state = apply(state, active, { type: 'DESIGNATE_VANGUARD', card: lead });
    state = untilStep(state, 'commit');
    const guard = standing(state, other);
    state = apply(state, other, { type: 'COMMIT_CHARACTER', card: guard });
    expect(windowOf(state)).toBe('beforeDamage');

    // +1/+1 on the vanguard: a 1/1 against a 1/1 becomes a 2/2, and only
    // one of them walks away.
    const open = engine
      .legalActions(state, active)
      .find(
        (action): action is Extract<GameAction, { type: 'OPEN_CARD' }> =>
          action.type === 'OPEN_CARD' && action.card === buff.card && action.targets?.[0] === lead,
      );
    expect(open, 'the buff should be offered on the vanguard').toBeDefined();
    state = apply(state, active, open as GameAction);
    state = apply(state, active, { type: 'PASS_PRIORITY' });

    expect(state.battle).toBeNull();
    expect(state.cards[lead]?.zone).toBe('city');
    expect(state.cards[guard]?.zone).toBe('trash');
  });
});

/* ------------------------------------------------------------------ helpers */

/** Moves the turn to a phase directly, skipping what it took to get there. */
function atPhase(state: GameState, phase: string): GameState {
  const phaseIndex = state.phases.findIndex((definition) => definition.id === phase);
  return { ...state, turn: { ...state.turn, phaseIndex } };
}

/** Stands a card face up in a city, so there is somebody to fight with. */
function faceUp(state: GameState, player: PlayerId, defId: string, city: number): GameState {
  const placed = set(state, player, defId, city);
  const card = placed.state.cards[placed.card] as CardInstance;
  return {
    ...placed.state,
    cards: { ...placed.state.cards, [placed.card]: { ...card, faceUp: true } },
  };
}

/** Plays the active player's turn out until something stops it. */
function runOut(state: GameState, player: PlayerId): GameState {
  let next = state;
  for (let guard = 0; guard < 24; guard++) {
    if (next.quick) return next;
    if (next.turn.activePlayer !== player) return next;
    const actions = engine.legalActions(next, next.turn.priorityPlayer);
    const discard = actions.find((action) => action.type === 'DISCARD_CARD');
    const end = actions.find((action) => action.type === 'END_PHASE');
    if (discard) next = apply(next, next.turn.priorityPlayer, discard);
    else if (end) next = apply(next, next.turn.priorityPlayer, end);
    else return next;
  }
  return next;
}

/** One white card from a hand, which is what these costs want. */
function payableWith(state: GameState, player: PlayerId): CardInstanceId[] {
  const hand = state.zoneOrder[`${player}:hand`] ?? [];
  return hand.slice(0, 1) as CardInstanceId[];
}

/** The face-up character this player has standing on the field. */
function standing(state: GameState, player: PlayerId): CardInstanceId {
  const card = Object.values(state.cards).find(
    (candidate) => candidate.controller === player && candidate.zone === 'city' && candidate.faceUp,
  );
  if (!card) throw new Error('nobody standing');
  return card.instanceId;
}

/** Passes on every window on offer, whoever it is waiting on. */
function declineWindows(state: GameState): GameState {
  let next = state;
  for (let guard = 0; guard < 8 && next.quick; guard++) {
    next = apply(next, next.quick.waitingOn, { type: 'PASS_PRIORITY' });
  }
  return next;
}

/** Declines windows and battle steps until the battle reaches `step`. */
function untilStep(state: GameState, step: string): GameState {
  let next = state;
  for (let guard = 0; guard < 16; guard++) {
    next = declineWindows(next);
    if (!next.battle || next.battle.step === step) return next;
    next = apply(next, next.battle.waitingOn, { type: 'BATTLE_PASS' });
  }
  return next;
}
