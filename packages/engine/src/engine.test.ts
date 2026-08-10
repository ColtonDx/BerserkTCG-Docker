import { beforeEach, describe, expect, it } from 'vitest';
import { CardRegistry, parseCost, formatCost } from './cards.js';
import { PLACEHOLDER_CARDS, placeholderDeck } from './data/placeholder-cards.js';
import { createEngine, type Engine } from './engine.js';
import { asCardDefId, asMatchId, asPlayerId, type PlayerId } from './ids.js';
import { HAND_LIMIT, cityLevel, occupationWinner } from './rules.js';
import { STARTING_HAND_SIZE } from './setup.js';
import type { GameAction, GameState } from './types.js';
import { zoneSize } from './zones.js';

const ALICE = asPlayerId('alice');
const BOB = asPlayerId('bob');

let engine: Engine;

beforeEach(() => {
  engine = createEngine(new CardRegistry(PLACEHOLDER_CARDS));
});

function newMatch(seed = 1): GameState {
  return engine.createMatch({
    matchId: asMatchId('test-match'),
    seed,
    decks: [
      { playerId: ALICE, name: 'Alice', cards: placeholderDeck(45) },
      { playerId: BOB, name: 'Bob', cards: placeholderDeck(45) },
    ],
  });
}

/** Settles mulligans so tests can start from turn 1. */
function started(seed = 1): GameState {
  const result = engine.reduceAll(newMatch(seed), [
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

/** Ends the current turn, discarding down to the hand limit if required. */
/**
 * Puts play back at the Open step.
 *
 * The engine now skips a phase that offers nothing but leaving it, so a test
 * that places a Set Card *after* reaching turn two has already been carried
 * past the step it wants to test — at the time it was reached, there was
 * nothing to open.
 */
function atOpenStep(state: GameState): GameState {
  const phaseIndex = state.phases.findIndex((phase) => phase.id === 'open');
  return { ...state, turn: { ...state.turn, phaseIndex } };
}

function endTurn(state: GameState): GameState {
  const player = state.turn.activePlayer;
  let current = state;
  for (let guard = 0; guard < 20; guard++) {
    if (current.turn.activePlayer !== player) return current;
    const actions = engine.legalActions(current, current.turn.priorityPlayer);
    const next =
      actions.find((a) => a.type === 'END_PHASE') ?? actions.find((a) => a.type === 'DISCARD_CARD');
    if (!next) throw new Error('no way to advance the turn');
    current = apply(current, current.turn.priorityPlayer, next);
  }
  throw new Error('turn did not end');
}

describe('createMatch', () => {
  it('lays out five face-down cities and deals seven cards', () => {
    const state = newMatch();

    expect(state.status.kind).toBe('setup');
    expect(state.cities).toHaveLength(5);
    expect(state.cities.every((c) => !c.faceUp)).toBe(true);
    expect(state.cities.filter((c) => c.royalCapital)).toHaveLength(1);
    // Rules.md §5 — all cities start face-down, so City Lv. is 0.
    expect(cityLevel(state)).toBe(0);
    expect(zoneSize(state, ALICE, 'hand')).toBe(STARTING_HAND_SIZE);
    expect(zoneSize(state, ALICE, 'deck')).toBe(45 - STARTING_HAND_SIZE);
  });

  it('is deterministic for a given seed', () => {
    expect(JSON.stringify(newMatch(42))).toBe(JSON.stringify(newMatch(42)));
  });

  it('produces different shuffles for different seeds', () => {
    const hand = (seed: number) => newMatch(seed).zoneOrder[`${ALICE}:hand`];
    expect(hand(1)).not.toEqual(hand(2));
  });

  it('rejects decks referencing unknown cards', () => {
    expect(() =>
      engine.createMatch({
        matchId: asMatchId('bad'),
        seed: 1,
        decks: [
          { playerId: ALICE, name: 'Alice', cards: [asCardDefId('nope')] },
          { playerId: BOB, name: 'Bob', cards: placeholderDeck(45) },
        ],
      }),
    ).toThrow(/unknown card/i);
  });

  it('enforces deckbuilding limits when asked', () => {
    expect(() =>
      engine.createMatch({
        matchId: asMatchId('small'),
        seed: 1,
        validateDecks: true,
        decks: [
          { playerId: ALICE, name: 'Alice', cards: placeholderDeck(10) },
          { playerId: BOB, name: 'Bob', cards: placeholderDeck(45) },
        ],
      }),
    ).toThrow(/exactly 45 cards|not a card/i);
  });
});

describe('mulligans (Rules.md §9, DesignNotes 5)', () => {
  it('redraws a full hand and owes nothing until the hand is kept', () => {
    const state = apply(newMatch(), ALICE, { type: 'MULLIGAN' });

    expect(zoneSize(state, ALICE, 'hand')).toBe(STARTING_HAND_SIZE);
    // The cost is not paid yet — deciding comes first, so a player never
    // bottoms cards from a hand they are about to mulligan away again.
    expect(state.pendingBottom[ALICE] ?? 0).toBe(0);
    expect(state.handTarget[ALICE]).toBe(STARTING_HAND_SIZE - 1);

    const types = new Set(engine.legalActions(state, ALICE).map((a) => a.type));
    expect(types.has('MULLIGAN')).toBe(true);
    expect(types.has('KEEP_HAND')).toBe(true);
    expect(types.has('BOTTOM_CARD')).toBe(false);
  });

  it('asks for the bottomed card only once the hand is kept', () => {
    let state = apply(newMatch(), ALICE, { type: 'MULLIGAN' });
    state = apply(state, ALICE, { type: 'KEEP_HAND' });

    expect(state.pendingBottom[ALICE]).toBe(1);
    expect(state.mulliganPending).toContain(ALICE);

    const actions = engine.legalActions(state, ALICE);
    expect(actions.every((a) => a.type === 'BOTTOM_CARD' || a.type === 'CONCEDE')).toBe(true);
  });

  it('leaves a six-card hand once the owed card is bottomed', () => {
    let state = apply(newMatch(), ALICE, { type: 'MULLIGAN' });
    state = apply(state, ALICE, { type: 'KEEP_HAND' });
    const card = (state.zoneOrder[`${ALICE}:hand`] ?? [])[0];
    if (!card) throw new Error('expected a hand');
    state = apply(state, ALICE, { type: 'BOTTOM_CARD', card });

    expect(zoneSize(state, ALICE, 'hand')).toBe(STARTING_HAND_SIZE - 1);
    expect(state.pendingBottom[ALICE]).toBe(0);
    expect(zoneSize(state, ALICE, 'deck')).toBe(45 - (STARTING_HAND_SIZE - 1));
    // Bottoming the last owed card settles the keep.
    expect(state.mulliganPending).not.toContain(ALICE);
  });

  it('costs a second card for a second mulligan', () => {
    let state = apply(newMatch(), ALICE, { type: 'MULLIGAN' });
    state = apply(state, ALICE, { type: 'MULLIGAN' });

    expect(zoneSize(state, ALICE, 'hand')).toBe(STARTING_HAND_SIZE);
    expect(state.handTarget[ALICE]).toBe(STARTING_HAND_SIZE - 2);

    state = apply(state, ALICE, { type: 'KEEP_HAND' });
    expect(state.pendingBottom[ALICE]).toBe(2);
  });

  it('will not keep a hand while cards are still owed to the bottom', () => {
    let state = apply(newMatch(), ALICE, { type: 'MULLIGAN' });
    state = apply(state, ALICE, { type: 'KEEP_HAND' });
    const result = engine.reduce(state, ALICE, { type: 'KEEP_HAND' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ALREADY_ACTED');
  });

  it('starts the match only once both players have kept', () => {
    let state = apply(newMatch(), ALICE, { type: 'KEEP_HAND' });
    expect(state.status.kind).toBe('setup');

    state = apply(state, BOB, { type: 'KEEP_HAND' });
    expect(state.status.kind).toBe('playing');
    expect(state.turn.turnNumber).toBe(1);
  });
});

describe('turn structure (Rules.md §10)', () => {
  it('skips Refresh, Draw, and the turn-one Open step', () => {
    const state = started();
    // DesignNotes 7 — turn one has no Open step, so play rests on Main.
    expect(state.phases[state.turn.phaseIndex]?.id).toBe('main');
  });

  it('does not draw on the first player’s first turn', () => {
    const state = started();
    expect(zoneSize(state, state.turn.activePlayer, 'hand')).toBe(STARTING_HAND_SIZE);
  });

  it('draws for the second player on their first turn', () => {
    const state = started();
    const second = state.seats[1] as PlayerId;
    const next = endTurn(state);

    expect(next.turn.activePlayer).toBe(second);
    expect(zoneSize(next, second, 'hand')).toBe(STARTING_HAND_SIZE + 1);
  });

  it('offers an Open step from the second turn onward', () => {
    let state = started();
    // Set something first: an Open step with nothing openable is skipped.
    const player = state.turn.activePlayer;
    const card = (state.zoneOrder[`${player}:hand`] ?? [])[0];
    if (!card) throw new Error('expected an opening hand');
    state = apply(state, player, { type: 'SET_CARD', card, city: 0 });

    state = endTurn(state); // second player's first turn
    state = endTurn(state); // back to the first player, turn 2

    expect(state.turn.turnNumber).toBe(2);
    expect(state.phases[state.turn.phaseIndex]?.id).toBe('open');
  });

  it('skips the Open step when there is nothing to open', () => {
    // A step that offers only "next phase" is a click with no decision in it.
    let state = started();
    state = endTurn(state);
    state = endTurn(state);

    expect(state.turn.turnNumber).toBe(2);
    expect(state.phases[state.turn.phaseIndex]?.id).toBe('main');
  });

  it('leaves the Open step as soon as the turn’s one open is spent', () => {
    // §10 ③ — one open a turn. Taking it is what empties the step, and the
    // step empties in the middle of an action rather than on entry, so the
    // engine has to notice then too.
    let state = started();
    const player = state.turn.activePlayer;
    const hand = state.zoneOrder[`${player}:hand`] ?? [];
    const card = hand.find((id) => state.cards[id]?.defId === asCardDefId('dev-001'));
    if (!card) throw new Error('expected a mercenary');

    state = apply(state, player, { type: 'SET_CARD', card, city: 1 });
    state = endTurn(endTurn(state));
    expect(state.phases[state.turn.phaseIndex]?.id).toBe('open');

    const open = engine
      .legalActions(state, player)
      .find((a) => a.type === 'OPEN_CARD' && a.card === card);
    state = apply(state, player, open as GameAction);

    expect(state.phases[state.turn.phaseIndex]?.id).toBe('main');
    expect(engine.legalActions(state, player).some((a) => a.type === 'OPEN_CARD')).toBe(false);
  });

  it('ends a turn with nothing left in it', () => {
    // Empty hand, nothing on the board: Main has no move in it either, so
    // play passes rather than asking the player to confirm twice.
    let state = started();
    const player = state.turn.activePlayer;
    state = {
      ...state,
      cards: Object.fromEntries(
        Object.entries(state.cards).map(([id, card]) => [
          id,
          card.controller === player && card.zone === 'hand'
            ? { ...card, zone: 'trash' as const }
            : card,
        ]),
      ),
      zoneOrder: { ...state.zoneOrder, [`${player}:hand`]: [] },
    };

    const result = engine.reduce(state, player, { type: 'END_PHASE' });
    if (!result.ok) throw new Error('expected the phase to end');
    // Straight past Main and End to the opponent.
    expect(result.value.state.turn.activePlayer).not.toBe(player);
  });

  it('unlocks the turn player’s cards during Refresh', () => {
    let state = started();
    const hand = state.zoneOrder[`${state.turn.activePlayer}:hand`] ?? [];
    const card = hand[0];
    if (!card) throw new Error('expected a hand');

    state = apply(state, state.turn.activePlayer, { type: 'SET_CARD', card, city: 0 });
    // Force the card into a locked state to prove Refresh clears it.
    const locked: GameState = {
      ...state,
      cards: { ...state.cards, [card]: { ...state.cards[card]!, locked: true } },
    };

    const afterTwoTurns = endTurn(endTurn(locked));
    expect(afterTwoTurns.cards[card]?.locked).toBe(false);
  });

  it('requires discarding down to seven before the turn can pass', () => {
    let state = started();
    state = endTurn(state); // pass to the second player, who drew to 8

    const player = state.turn.activePlayer;
    expect(zoneSize(state, player, 'hand')).toBe(STARTING_HAND_SIZE + 1);

    // Walk to the End phase; it must stop there and demand a discard.
    while (state.phases[state.turn.phaseIndex]?.id !== 'end') {
      state = apply(state, player, { type: 'END_PHASE' });
    }
    expect(zoneSize(state, player, 'hand')).toBeGreaterThan(HAND_LIMIT);

    const blocked = engine.reduce(state, player, { type: 'END_PHASE' });
    expect(blocked.ok).toBe(false);

    const discards = engine.legalActions(state, player);
    expect(discards.every((a) => a.type === 'DISCARD_CARD' || a.type === 'CONCEDE')).toBe(true);
  });
});

describe('setting and opening cards (Rules.md §7)', () => {
  it('sets a card face-down into a city', () => {
    let state = started();
    const player = state.turn.activePlayer;
    const card = (state.zoneOrder[`${player}:hand`] ?? [])[0];
    if (!card) throw new Error('expected a hand');

    state = apply(state, player, { type: 'SET_CARD', card, city: 2 });

    expect(state.cards[card]).toMatchObject({ zone: 'city', cityIndex: 2, faceUp: false });
    // A face-down Set Card is not a presence, so the city stays face-down.
    expect(state.cities[2]?.faceUp).toBe(false);
    expect(cityLevel(state)).toBe(0);
  });

  it('opens a Level 0 card and pays its cost, leaving the city asleep', () => {
    let state = started();
    const player = state.turn.activePlayer;
    const hand = state.zoneOrder[`${player}:hand`] ?? [];
    const mercenary = hand.find((id) => state.cards[id]?.defId === asCardDefId('dev-001'));
    if (!mercenary) throw new Error('expected a mercenary in the opening hand');

    state = apply(state, player, { type: 'SET_CARD', card: mercenary, city: 1 });
    state = endTurn(state);
    state = endTurn(state); // back to `player`, now in their Open phase

    const open = engine
      .legalActions(state, player)
      .find((a) => a.type === 'OPEN_CARD' && a.card === mercenary);
    expect(open, 'the set mercenary should be openable').toBeDefined();

    const handBefore = zoneSize(state, player, 'hand');
    state = apply(state, player, open as GameAction);

    expect(state.cards[mercenary]?.faceUp).toBe(true);
    // Rules.md §7 — cost is paid by moving cards from hand to the Trash.
    expect(zoneSize(state, player, 'hand')).toBe(handBefore - 1);
    expect(zoneSize(state, player, 'trash')).toBe(1);
    // Rules.md §5 — a city is woken by being attacked, not by someone standing
    // in it, so opening here raises City Level not at all.
    expect(state.cities[1]?.faceUp).toBe(false);
    expect(cityLevel(state)).toBe(0);
    expect(state.turn.openedThisTurn).toBe(true);
  });

  it('allows only one open per turn (Rules.md §10 ③)', () => {
    let state = started();
    const player = state.turn.activePlayer;
    const hand = [...(state.zoneOrder[`${player}:hand`] ?? [])];
    const mercenaries = hand.filter((id) => state.cards[id]?.defId === asCardDefId('dev-001'));
    if (mercenaries.length < 2) throw new Error('expected two mercenaries');

    for (const card of mercenaries.slice(0, 2)) {
      state = apply(state, player, { type: 'SET_CARD', card, city: 1 });
    }
    state = endTurn(endTurn(state));

    const first = engine.legalActions(state, player).find((a) => a.type === 'OPEN_CARD');
    state = apply(state, player, first as GameAction);

    expect(engine.legalActions(state, player).some((a) => a.type === 'OPEN_CARD')).toBe(false);
  });

  it('never offers an open the player cannot pay for (DesignNotes 9)', () => {
    let state = started();
    const player = state.turn.activePlayer;
    const card = (state.zoneOrder[`${player}:hand`] ?? [])[0];
    if (!card) throw new Error('expected a hand');

    state = apply(state, player, { type: 'SET_CARD', card, city: 0 });
    state = endTurn(endTurn(state));
    expect(state.phases[state.turn.phaseIndex]?.id).toBe('open');
    expect(engine.legalActions(state, player).some((a) => a.type === 'OPEN_CARD')).toBe(true);

    // With an empty hand there is nothing to pay with, so no open is offered.
    const broke: GameState = {
      ...state,
      zoneOrder: { ...state.zoneOrder, [`${player}:hand`]: [] },
    };
    expect(engine.legalActions(broke, player).some((a) => a.type === 'OPEN_CARD')).toBe(false);
  });

  it('counts City Level globally, so a flip anywhere gates every city', () => {
    const state = started();
    const faceUp = (indices: number[]): GameState => ({
      ...state,
      cities: state.cities.map((city) => ({ ...city, faceUp: indices.includes(city.index) })),
    });

    expect(cityLevel(faceUp([]))).toBe(0);
    expect(cityLevel(faceUp([0]))).toBe(1);
    // Cities 0 and 4 are far apart; the level is still the shared total.
    expect(cityLevel(faceUp([0, 4]))).toBe(2);
    expect(cityLevel(faceUp([0, 1, 2, 3, 4]))).toBe(5);
  });

  it('gates a card in one city on cities flipped elsewhere', () => {
    const state = endTurn(endTurn(started()));
    const player = state.turn.activePlayer;

    const level2 = Object.values(state.cards).find(
      (card) => card.defId === asCardDefId('dev-003') && card.owner === player,
    );
    if (!level2) throw new Error('expected a Level 2 card in the deck');

    // dev-003 costs 1WW, so stock the hand with white cards it can pay with.
    const white = Object.values(state.cards)
      .filter(
        (card) =>
          card.owner === player &&
          card.instanceId !== level2.instanceId &&
          (card.defId === asCardDefId('dev-003') || card.defId === asCardDefId('dev-005')),
      )
      .slice(0, 3);
    if (white.length < 3) throw new Error('expected three white cards to pay with');

    // Set it in city 4, with no city face up: not openable.
    const built: GameState = {
      ...state,
      cards: {
        ...state.cards,
        [level2.instanceId]: { ...level2, zone: 'city', cityIndex: 4, faceUp: false },
        ...Object.fromEntries(white.map((card) => [card.instanceId, { ...card, zone: 'hand' }])),
      },
      zoneOrder: {
        ...state.zoneOrder,
        [`${player}:deck`]: [],
        [`${player}:hand`]: white.map((card) => card.instanceId),
      },
    };
    const base = atOpenStep(built);
    const openable = (s: GameState): boolean =>
      engine
        .legalActions(s, player)
        .some((a) => a.type === 'OPEN_CARD' && a.card === level2.instanceId);

    expect(openable(base)).toBe(false);

    // Flip two *other* cities (0 and 1). City Lv. is now 2, so the Level 2
    // card in city 4 becomes openable.
    const raised: GameState = {
      ...base,
      cities: base.cities.map((city) => ({
        ...city,
        faceUp: city.index === 0 || city.index === 1,
      })),
    };
    expect(cityLevel(raised)).toBe(2);
    expect(openable(raised)).toBe(true);
  });

  it('will not open a Unique card when that name is already on the field', () => {
    // Rules.md §8 — one card of a name on the field at a time, and it does not
    // matter whose. The card stays a Set Card; nothing is paid.
    // Turn one has no Open step (DesignNotes 7), so play round to one.
    let state = started();
    state = endTurn(state);
    state = endTurn(state);
    const player = state.turn.activePlayer;
    const opponent = state.seats.find((seat) => seat !== player) as PlayerId;

    const banner = Object.values(state.cards).find(
      (card) => card.defId === asCardDefId('dev-005') && card.controller === player,
    );
    if (!banner) throw new Error('expected a Placeholder Banner somewhere');

    // The opponent already has one open, and a city is face up so the Level
    // gate is not what stops this.
    const theirs = Object.values(state.cards).find(
      (card) => card.defId === asCardDefId('dev-005') && card.controller === opponent,
    );
    if (!theirs) throw new Error('expected the opponent to hold one too');

    state = atOpenStep({
      ...state,
      cards: {
        ...state.cards,
        [banner.instanceId]: { ...banner, zone: 'city', cityIndex: 1, faceUp: false },
        [theirs.instanceId]: { ...theirs, zone: 'city', cityIndex: 3, faceUp: true },
      },
      cities: state.cities.map((city) => (city.index === 3 ? { ...city, faceUp: true } : city)),
    });
    // With a Set Card down there is something to open, so the step stands.
    expect(state.phases[state.turn.phaseIndex]?.id).toBe('open');

    const offered = engine
      .legalActions(state, player)
      .some((a) => a.type === 'OPEN_CARD' && a.card === banner.instanceId);
    expect(offered, 'a conflicting Unique should never be offered').toBe(false);

    // And the reducer refuses it even when asked directly.
    const result = engine.reduce(state, player, {
      type: 'OPEN_CARD',
      card: banner.instanceId,
      pay: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.rule).toBe('§8');
      expect(result.error.message).toMatch(/Unique/);
    }
  });

  it('rejects opening a card above the City Level', () => {
    const state = endTurn(endTurn(started()));
    const player = state.turn.activePlayer;

    // Place a Level 2 card as a Set Card directly; the draw is random, so
    // reaching this position through play would be flaky.
    const high = Object.values(state.cards).find(
      (card) => card.defId === asCardDefId('dev-003') && card.owner === player,
    );
    if (!high) throw new Error('expected a Level 2 card in the deck');

    const positioned: GameState = atOpenStep({
      ...state,
      cards: {
        ...state.cards,
        [high.instanceId]: { ...high, zone: 'city', cityIndex: 0, faceUp: false },
      },
      zoneOrder: {
        ...state.zoneOrder,
        [`${player}:deck`]: (state.zoneOrder[`${player}:deck`] ?? []).filter(
          (id) => id !== high.instanceId,
        ),
        [`${player}:hand`]: (state.zoneOrder[`${player}:hand`] ?? []).filter(
          (id) => id !== high.instanceId,
        ),
      },
    });

    // City Lv. is still 0, so a Level 2 card cannot be opened.
    expect(cityLevel(positioned)).toBe(0);
    expect(engine.legalActions(positioned, player).some((a) => a.type === 'OPEN_CARD')).toBe(false);

    const result = engine.reduce(positioned, player, {
      type: 'OPEN_CARD',
      card: high.instanceId,
      pay: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.rule).toBe('§7');
  });
});

describe('movement (Rules.md §10 ④)', () => {
  it('locks a character when it moves and respects its Move range', () => {
    let state = started();
    const player = state.turn.activePlayer;
    const hand = state.zoneOrder[`${player}:hand`] ?? [];
    const mercenary = hand.find((id) => state.cards[id]?.defId === asCardDefId('dev-001'));
    if (!mercenary) throw new Error('expected a mercenary');

    state = apply(state, player, { type: 'SET_CARD', card: mercenary, city: 1 });
    state = endTurn(endTurn(state));
    const open = engine
      .legalActions(state, player)
      .find((a) => a.type === 'OPEN_CARD' && a.card === mercenary);
    state = apply(state, player, open as GameAction);
    // §10 ③ allows one open a turn, so taking it empties the step and the
    // engine moves on rather than asking the player to dismiss it.
    expect(state.phases[state.turn.phaseIndex]?.id).toBe('main');

    // Move 1: city 0 and 2 are reachable, city 3 is not.
    const moves = engine
      .legalActions(state, player)
      .filter((a) => a.type === 'MOVE_CHARACTER' && a.card === mercenary);
    expect(moves.map((m) => (m as { city: number }).city).sort()).toEqual([0, 2]);

    state = apply(state, player, { type: 'MOVE_CHARACTER', card: mercenary, city: 2 });
    expect(state.cards[mercenary]).toMatchObject({ cityIndex: 2, locked: true });

    // Rules.md §5 — moving into a city does not wake it; only attacking does.
    expect(state.cities[1]?.faceUp).toBe(false);
    expect(state.cities[2]?.faceUp).toBe(false);

    const again = engine.reduce(state, player, {
      type: 'MOVE_CHARACTER',
      card: mercenary,
      city: 1,
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('ALREADY_ACTED');
  });
});

describe('win conditions (Rules.md §1)', () => {
  it('awards the match on three cities including the Royal Capital', () => {
    const state = started();
    const capital = state.cities.find((c) => c.royalCapital);
    if (!capital) throw new Error('expected a Royal Capital');
    const others = state.cities.filter((c) => !c.royalCapital).slice(0, 2);

    const occupied: GameState = {
      ...state,
      cities: state.cities.map((city) =>
        city.royalCapital || others.includes(city) ? { ...city, occupiedBy: ALICE } : city,
      ),
    };

    expect(occupationWinner(occupied)).toBe(ALICE);
  });

  it('does not award the match without the Royal Capital', () => {
    const state = started();
    const occupied: GameState = {
      ...state,
      cities: state.cities.map((city) =>
        city.royalCapital ? city : { ...city, occupiedBy: ALICE },
      ),
    };

    expect(occupationWinner(occupied)).toBeNull();
  });

  it('ends the match when a player must draw from an empty deck', () => {
    const state = started();
    const player = state.seats[1] as PlayerId;
    const emptied: GameState = {
      ...state,
      zoneOrder: { ...state.zoneOrder, [`${player}:deck`]: [] },
    };

    const next = endTurn(emptied); // passes to `player`, forcing their draw
    expect(next.status).toMatchObject({ kind: 'finished', reason: 'deck_out' });
    if (next.status.kind === 'finished') expect(next.status.winner).toBe(state.seats[0]);
  });

  it('lets either player concede at any time', () => {
    const state = started();
    const result = engine.reduce(state, BOB, { type: 'CONCEDE' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.status).toMatchObject({
      kind: 'finished',
      winner: ALICE,
      reason: 'concede',
    });
  });

  it('refuses further actions once the match is over', () => {
    const conceded = engine.reduce(started(), ALICE, { type: 'CONCEDE' });
    if (!conceded.ok) throw new Error('expected success');

    const after = engine.reduce(conceded.value.state, BOB, { type: 'END_PHASE' });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error.code).toBe('GAME_OVER');
  });
});

describe('reduce', () => {
  it('does not mutate the state it was given', () => {
    const state = started();
    const before = JSON.stringify(state);

    engine.reduce(state, state.turn.activePlayer, { type: 'END_PHASE' });

    expect(JSON.stringify(state)).toBe(before);
  });

  it('rejects actions from the player without priority', () => {
    const state = started();
    const idle = state.seats[1] as PlayerId;
    const result = engine.reduce(state, idle, { type: 'END_PHASE' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_YOUR_PRIORITY');
  });

  it('bumps the version on every applied action', () => {
    const state = started();
    const result = engine.reduce(state, state.turn.activePlayer, { type: 'END_PHASE' });
    if (!result.ok) throw new Error('expected success');
    expect(result.value.state.version).toBe(state.version + 1);
  });
});

describe('legalActions', () => {
  it('agrees with the reducer: everything offered is accepted', () => {
    // Walk a few turns so the check covers setup, Main, Open, and End.
    let state = newMatch();
    const scripted: GameAction[] = [{ type: 'KEEP_HAND' }, { type: 'KEEP_HAND' }];

    for (const action of scripted) {
      const actor = state.mulliganPending[0];
      if (!actor) break;
      state = apply(state, actor, action);
    }

    for (let turn = 0; turn < 4; turn++) {
      for (const player of state.seats) {
        for (const action of engine.legalActions(state, player)) {
          const result = engine.reduce(state, player, action);
          expect(result.ok, `${player} ${action.type} should be accepted`).toBe(true);
        }
      }
      state = endTurn(state);
    }
  });

  it('offers nothing but conceding to the player without priority', () => {
    const state = started();
    const idle = state.seats[1] as PlayerId;
    expect(engine.legalActions(state, idle)).toEqual([{ type: 'CONCEDE' }]);
  });

  it('offers nothing once the match is finished', () => {
    const result = engine.reduce(started(), ALICE, { type: 'CONCEDE' });
    if (!result.ok) throw new Error('expected success');
    expect(engine.legalActions(result.value.state, BOB)).toEqual([]);
  });
});

describe('viewFor', () => {
  it("hides the opponent's hand but reveals its size", () => {
    const state = started();
    const view = engine.viewFor(state, ALICE);

    const bobHand = state.zoneOrder[`${BOB}:hand`] ?? [];
    for (const id of bobHand) expect(view.cards[id]).toMatchObject({ hidden: true });
    expect(view.zoneCounts[`${BOB}:hand`]).toBe(STARTING_HAND_SIZE);
    // The opponent's hand order is not sent at all.
    expect(view.zoneOrder[`${BOB}:hand`]).toBeUndefined();
  });

  it("reveals the viewer's own hand", () => {
    const state = started();
    const view = engine.viewFor(state, ALICE);

    for (const id of state.zoneOrder[`${ALICE}:hand`] ?? []) {
      expect(view.cards[id]).toHaveProperty('defId');
    }
  });

  it('never exposes deck contents or deck order to anyone', () => {
    const state = started();
    for (const viewer of [ALICE, BOB] as PlayerId[]) {
      const view = engine.viewFor(state, viewer);
      expect(view.zoneOrder[`${viewer}:deck`]).toBeUndefined();
      for (const id of state.zoneOrder[`${viewer}:deck`] ?? []) {
        expect(view.cards[id]).toMatchObject({ hidden: true });
      }
    }
  });

  it("hides an opponent's Set Card but shows which city it is in", () => {
    let state = started();
    const player = state.turn.activePlayer;
    const opponent = state.seats.find((s) => s !== player) as PlayerId;
    const card = (state.zoneOrder[`${player}:hand`] ?? [])[0];
    if (!card) throw new Error('expected a hand');

    state = apply(state, player, { type: 'SET_CARD', card, city: 3 });

    // Rules.md §7 — you may always check your own Set Cards.
    expect(engine.viewFor(state, player).cards[card]).toHaveProperty('defId');

    const hidden = engine.viewFor(state, opponent).cards[card];
    expect(hidden).toMatchObject({ hidden: true, cityIndex: 3 });
    expect(hidden).not.toHaveProperty('defId');
  });

  it('hides which face-down city is the Royal Capital', () => {
    const state = started();
    const view = engine.viewFor(state, ALICE);

    expect(view.cities.every((city) => 'hidden' in city)).toBe(true);
    expect(JSON.stringify(view.cities)).not.toContain('royalCapital');
  });

  it('leaks no hidden card identities in the serialized view', () => {
    const state = started();
    const view = engine.viewFor(state, ALICE);

    const visible = new Set(
      (state.zoneOrder[`${ALICE}:hand`] ?? []).map((id) => state.cards[id]?.defId),
    );
    const serialized = JSON.stringify(view);

    for (const id of state.zoneOrder[`${BOB}:hand`] ?? []) {
      const card = state.cards[id];
      // A def id may legitimately appear if Alice holds the same card.
      if (!card || visible.has(card.defId)) continue;
      expect(serialized).not.toContain(card.defId);
    }
  });
});

describe('cost notation (DesignNotes 8)', () => {
  it.each([
    ['BB', 2, 'two black'],
    ['1B', 2, 'one generic and one black'],
    ['RGB', 3, 'one of three colours'],
    ['0', 0, 'free'],
    ['', 0, 'free'],
  ])('parses %s as %i card(s) — %s', (notation, total) => {
    const cost = parseCost(notation);
    expect(cost.reduce((sum, icon) => sum + icon.count, 0)).toBe(total);
  });

  it('splits colours and generic correctly', () => {
    expect(parseCost('1B')).toEqual([
      { color: 'any', count: 1 },
      { color: 'black', count: 1 },
    ]);
    expect(parseCost('BB')).toEqual([{ color: 'black', count: 2 }]);
  });

  it('round-trips through formatCost', () => {
    // `formatCost` emits a canonical colour order, so the round trip is
    // checked semantically rather than as an exact string match.
    for (const notation of ['BB', '1B', 'RGB', '2WW', '0']) {
      const cost = parseCost(notation);
      expect(parseCost(formatCost(cost))).toEqual(cost);
    }
    expect(formatCost(parseCost('1B'))).toBe('1B');
    expect(formatCost(parseCost('BB'))).toBe('BB');
  });

  it('rejects invalid notation', () => {
    expect(() => parseCost('XY')).toThrow(/invalid cost/i);
  });
});

describe('the Battle phase (Rules.md §11-12)', () => {
  /**
   * Battles need characters standing in a city, and getting there through the
   * turn structure takes many turns. These are rules tests, not turn-structure
   * tests, so the board is placed directly and the battle is then fought
   * entirely through `reduce`.
   */
  function withGarrison(
    attackers: readonly string[],
    defenders: readonly string[],
    city = 2,
    occupiedBy: PlayerId | null = null,
  ): { state: GameState; attacker: PlayerId; defender: PlayerId } {
    let state = started();
    const attacker = state.turn.activePlayer;
    const defender = state.seats.find((seat) => seat !== attacker) as PlayerId;

    const cards = { ...state.cards };
    const place = (owner: PlayerId, defIds: readonly string[], index: number): void => {
      const theirs = Object.values(cards).filter(
        (card) => card.controller === owner && card.zone === 'hand',
      );
      defIds.forEach((defId, i) => {
        const card = theirs[i];
        if (!card) throw new Error('not enough cards in hand to place');
        cards[card.instanceId] = {
          ...card,
          defId: asCardDefId(defId),
          zone: 'city',
          cityIndex: index,
          faceUp: true,
          locked: false,
          damage: 0,
        };
      });
    };
    place(attacker, attackers, city);
    place(defender, defenders, city);

    state = {
      ...state,
      cards,
      cities: state.cities.map((c) => (c.index === city ? { ...c, faceUp: true, occupiedBy } : c)),
    };
    return { state, attacker, defender };
  }

  const inCity = (state: GameState, player: PlayerId, city = 2): CardInstance[] =>
    Object.values(state.cards).filter(
      (card) => card.zone === 'city' && card.cityIndex === city && card.controller === player,
    );

  it('declares, names a vanguard, and locks it', () => {
    const { state: start, attacker } = withGarrison(['dev-001'], ['dev-001']);
    let state = apply(start, attacker, { type: 'DECLARE_BATTLE', city: 2 });

    expect(state.battle).not.toBeNull();
    expect(state.battle?.step).toBe('vanguard');
    expect(state.battle?.waitingOn).toBe(attacker);

    const lead = inCity(state, attacker)[0] as CardInstance;
    state = apply(state, attacker, { type: 'DESIGNATE_VANGUARD', card: lead.instanceId });

    // §11 ① — the vanguard is locked by leading.
    expect(state.cards[lead.instanceId]?.locked).toBe(true);
    expect(state.battle?.vanguard).toBe(lead.instanceId);
    expect(state.battle?.participants).toContain(lead.instanceId);
    // §11 ② is the combat open, but neither side has anything set in this
    // city, so nobody is asked and the fight starts.
    expect(state.battle?.step).toBe('commit');
  });

  it('ends the battle if no vanguard is named, having spent nothing', () => {
    const { state: start, attacker } = withGarrison(['dev-001'], ['dev-001']);
    let state = apply(start, attacker, { type: 'DECLARE_BATTLE', city: 2 });
    const before = inCity(state, attacker)[0] as CardInstance;

    state = apply(state, attacker, { type: 'BATTLE_PASS' });

    expect(state.battle).toBeNull();
    expect(state.cards[before.instanceId]?.locked).toBe(false);
    expect(state.cities[2]?.occupiedBy).toBeNull();
  });

  /**
   * Runs the two optional combat opens past, so tests can reach the fight.
   * Usually a no-op now: a side with nothing openable in the contested city is
   * never asked, so the step passes itself.
   */
  function skipOpens(state: GameState): GameState {
    let next = state;
    for (let i = 0; i < 2 && next.battle?.step === 'opens'; i++) {
      next = apply(next, next.battle.waitingOn, { type: 'BATTLE_PASS' });
    }
    return next;
  }

  /**
   * Commits what it is told to, then lets the commitment step run out.
   *
   * Written as "commit these, then finish" rather than as a fixed sequence of
   * passes because the engine answers for a side with nobody left to commit —
   * so how many passes it takes depends on the board.
   */
  function commitThen(
    state: GameState,
    commits: readonly { player: PlayerId; card: CardInstanceId }[] = [],
  ): GameState {
    let next = state;
    const owed = [...commits];
    for (let i = 0; i < 12 && next.battle?.step === 'commit'; i++) {
      const turn = next.battle.waitingOn;
      const index = owed.findIndex((commit) => commit.player === turn);
      if (index === -1) {
        next = apply(next, turn, { type: 'BATTLE_PASS' });
        continue;
      }
      const [commit] = owed.splice(index, 1) as [{ player: PlayerId; card: CardInstanceId }];
      next = apply(next, turn, { type: 'COMMIT_CHARACTER', card: commit.card });
    }
    expect(owed).toEqual([]);
    return next;
  }

  it('offers the defender their combat open first, on the attacker’s turn', () => {
    const { state: start, attacker, defender } = withGarrison(['dev-001'], ['dev-001']);

    // Give the defender something to open there, and a city face up so its
    // Level can be paid for — otherwise the step has no answer and is skipped.
    const spare = Object.values(start.cards).find(
      (card) => card.controller === defender && card.zone === 'hand',
    ) as CardInstance;
    let state: GameState = {
      ...start,
      cards: {
        ...start.cards,
        [spare.instanceId]: {
          ...spare,
          defId: asCardDefId('dev-001'),
          zone: 'city',
          cityIndex: 2,
          faceUp: false,
        },
      },
    };

    state = apply(state, attacker, { type: 'DECLARE_BATTLE', city: 2 });
    const lead = inCity(state, attacker)[0] as CardInstance;
    state = apply(state, attacker, { type: 'DESIGNATE_VANGUARD', card: lead.instanceId });

    // §11 ② — defender first, and it is not their turn.
    expect(state.battle?.step).toBe('opens');
    expect(state.battle?.waitingOn).toBe(defender);
    expect(state.turn.activePlayer).toBe(attacker);
    expect(engine.legalActions(state, defender).some((a) => a.type === 'OPEN_CARD')).toBe(true);

    state = apply(state, defender, { type: 'BATTLE_PASS' });
    // The attacker has nothing to open, so their half of the step is skipped.
    expect(state.battle?.step).toBe('commit');
  });

  it('alternates commitment and starts the exchange on two passes', () => {
    const { state: start, attacker, defender } = withGarrison(['dev-001', 'dev-003'], ['dev-001']);
    let state = apply(start, attacker, { type: 'DECLARE_BATTLE', city: 2 });
    const lead = inCity(state, attacker)[0] as CardInstance;
    state = apply(state, attacker, { type: 'DESIGNATE_VANGUARD', card: lead.instanceId });
    state = skipOpens(state);

    expect(state.battle?.step).toBe('commit');
    expect(state.battle?.waitingOn).toBe(attacker);

    const second = inCity(state, attacker).find((c) => c.instanceId !== lead.instanceId);
    state = apply(state, attacker, {
      type: 'COMMIT_CHARACTER',
      card: (second as CardInstance).instanceId,
    });
    // Committing locks it and passes the turn to the other side. §11 ③.
    expect(state.cards[(second as CardInstance).instanceId]?.locked).toBe(true);
    expect(state.battle?.waitingOn).toBe(defender);

    const theirs = inCity(state, defender)[0] as CardInstance;
    state = apply(state, defender, { type: 'COMMIT_CHARACTER', card: theirs.instanceId });
    // Neither side has anyone left, so the engine answers for both and the
    // exchange begins without either being asked. §11 ③.
    expect(state.battle?.step).toBe('damage');
  });

  it('commits the whole garrison when the defender occupies the city', () => {
    // §11 ③ — lock state is irrelevant for defending a city you occupy.
    const {
      state: start,
      attacker,
      defender,
    } = withGarrison(['dev-001'], ['dev-001', 'dev-003'], 2, null);
    let state = {
      ...start,
      cities: start.cities.map((c) => (c.index === 2 ? { ...c, occupiedBy: defender } : c)),
    };
    // One of theirs is already locked, and must still be dragged in.
    const garrison = inCity(state, defender);
    const locked = garrison[0] as CardInstance;
    state = {
      ...state,
      cards: { ...state.cards, [locked.instanceId]: { ...locked, locked: true } },
    };

    state = apply(state, attacker, { type: 'DECLARE_BATTLE', city: 2 });
    const lead = inCity(state, attacker)[0] as CardInstance;
    state = apply(state, attacker, { type: 'DESIGNATE_VANGUARD', card: lead.instanceId });
    state = skipOpens(state);

    for (const card of garrison) {
      expect(state.battle?.participants, `${card.instanceId} should be dragged in`).toContain(
        card.instanceId,
      );
    }
  });

  it('strikes highest Range first, and the loser goes to the Trash', () => {
    // dev-002 Scout: Range 2, Power 1, HP 2. dev-001 Mercenary: Range 1, HP 2.
    const { state: start, attacker, defender } = withGarrison(['dev-002'], ['dev-001']);
    let state = apply(start, attacker, { type: 'DECLARE_BATTLE', city: 2 });
    const scout = inCity(state, attacker)[0] as CardInstance;
    state = apply(state, attacker, { type: 'DESIGNATE_VANGUARD', card: scout.instanceId });
    state = skipOpens(state);
    // The defender has to commit, or there is nobody to fight: an unopposed
    // battle ends as a stalemate with no damage exchanged at all. §11 ③.
    const theirSide = inCity(state, defender)[0] as CardInstance;
    state = commitThen(state, [{ player: defender, card: theirSide.instanceId }]);

    // One character a side, so each strike has exactly one enemy to spend its
    // Power on and there is nothing to choose. The engine answers a question
    // with one answer rather than asking it, so the whole exchange resolves
    // on the commitment that started it — see `battleOffersAChoice`.
    const merc = inCity(state, defender)[0] as CardInstance;
    expect(state.battle).toBeNull();

    // 1 Power against 2 HP either way: both take a point and both live.
    expect(state.cards[merc.instanceId]?.damage).toBe(1);
    expect(state.cards[merc.instanceId]?.zone).toBe('city');
    expect(state.cards[scout.instanceId]?.damage).toBe(1);
    expect(state.cards[scout.instanceId]?.zone).toBe('city');
    // Both survived on 1 damage each, so nobody took the city. §12 stalemate.
    expect(state.cities[2]?.occupiedBy).toBeNull();
  });

  it('takes the city when only the attacker is left, and draws two', () => {
    // Guardian: Power 2 against a Mercenary's 2 HP — lethal in one exchange.
    const { state: start, attacker, defender } = withGarrison(['dev-003'], ['dev-001']);
    let state = apply(start, attacker, { type: 'DECLARE_BATTLE', city: 2 });
    const guardian = inCity(state, attacker)[0] as CardInstance;
    const merc = inCity(state, defender)[0] as CardInstance;
    state = apply(state, attacker, { type: 'DESIGNATE_VANGUARD', card: guardian.instanceId });
    state = skipOpens(state);
    // Taken before the fight: winning the city draws two (§12), and the
    // exchange now resolves as soon as the last character is committed.
    const handBefore = zoneSize(state, attacker, 'hand');
    // The defender has to commit, or there is nobody to fight: an unopposed
    // battle ends as a stalemate with no damage exchanged at all. §11 ③.
    const theirSide = inCity(state, defender)[0] as CardInstance;
    state = commitThen(state, [{ player: defender, card: theirSide.instanceId }]);

    // Both are Range 1, so they strike in the same band and the damage lands
    // together (§11 ④). One enemy each, so neither assignment is a choice and
    // the engine spends both without asking.

    // The Mercenary died but still dealt its damage, being simultaneous.
    expect(state.cards[merc.instanceId]?.zone).toBe('trash');
    expect(state.cards[guardian.instanceId]?.damage).toBe(1);
    expect(state.cards[guardian.instanceId]?.zone).toBe('city');

    // §12 Occupation — only the attacker remains, so the city changes hands
    // and the city card's own effect draws them two.
    expect(state.battle).toBeNull();
    expect(state.cities[2]?.occupiedBy).toBe(attacker);
    expect(zoneSize(state, attacker, 'hand')).toBe(handBefore + 2);
  });

  it('leaves the city alone when the attack is repelled', () => {
    // Mercenary Power 1 into a Guardian with 5 HP: the attack bounces.
    const { state: start, attacker, defender } = withGarrison(['dev-001'], ['dev-003']);
    let state = apply(start, attacker, { type: 'DECLARE_BATTLE', city: 2 });
    const merc = inCity(state, attacker)[0] as CardInstance;
    const guardian = inCity(state, defender)[0] as CardInstance;
    state = apply(state, attacker, { type: 'DESIGNATE_VANGUARD', card: merc.instanceId });
    state = skipOpens(state);
    // The defender has to commit, or there is nobody to fight: an unopposed
    // battle ends as a stalemate with no damage exchanged at all. §11 ③.
    const theirSide = inCity(state, defender)[0] as CardInstance;
    state = commitThen(state, [{ player: defender, card: theirSide.instanceId }]);

    // One enemy each, so both strikes are forced and the engine spends them.
    expect(state.battle).toBeNull();
    expect(state.cards[merc.instanceId]?.zone).toBe('trash');
    // The Guardian took its point but has 5 HP, so it is still standing.
    expect(state.cards[guardian.instanceId]?.zone).toBe('city');
    // §12 Repel — you only occupy by attacking successfully.
    expect(state.cities[2]?.occupiedBy).toBeNull();
  });

  it('assigns damage itself when there is only one enemy to hit', () => {
    // §11 ④ — the striker spends all of its Power among enemy participants.
    // With one enemy standing, every legal split puts everything on that one
    // card, so asking would be offering a single button the player has to
    // press before the battle can finish. A battle never stops on a question
    // with one answer.
    const { state: start, attacker, defender } = withGarrison(['dev-003'], ['dev-001']);
    let state = apply(start, attacker, { type: 'DECLARE_BATTLE', city: 2 });
    const guardian = inCity(state, attacker)[0] as CardInstance;
    const merc = inCity(state, defender)[0] as CardInstance;
    state = apply(state, attacker, { type: 'DESIGNATE_VANGUARD', card: guardian.instanceId });
    state = skipOpens(state);
    state = commitThen(state, [{ player: defender, card: merc.instanceId }]);

    // Never rested on the damage step, and nobody was asked to assign.
    expect(state.battle).toBeNull();
    expect(engine.legalActions(state, attacker).some((a) => a.type === 'ASSIGN_DAMAGE')).toBe(
      false,
    );

    // And the damage still landed: Power 2 against 2 HP is lethal.
    expect(state.cards[merc.instanceId]?.zone).toBe('trash');
    expect(state.cities[2]?.occupiedBy).toBe(attacker);
  });

  it('still asks when the Power could be split between two enemies', () => {
    // The mirror of the above: two enemies is a real decision — concentrating
    // kills one, spreading may kill neither — so it is always asked.
    const { state: start, attacker, defender } = withGarrison(['dev-003'], ['dev-001', 'dev-001']);
    let state = apply(start, attacker, { type: 'DECLARE_BATTLE', city: 2 });
    const guardian = inCity(state, attacker)[0] as CardInstance;
    state = apply(state, attacker, { type: 'DESIGNATE_VANGUARD', card: guardian.instanceId });
    state = skipOpens(state);
    state = commitThen(
      state,
      inCity(state, defender).map((card) => ({ player: defender, card: card.instanceId })),
    );

    expect(state.battle?.step).toBe('damage');
    expect(engine.legalActions(state, attacker).some((a) => a.type === 'ASSIGN_DAMAGE')).toBe(true);
  });

  it('refuses an assignment that does not spend the whole Power', () => {
    // Two defenders, so the split is a real decision and the engine asks
    // rather than answering: with one enemy there is only one legal
    // assignment, and the step resolves itself before anything can be sent.
    const { state: start, attacker, defender } = withGarrison(['dev-003'], ['dev-001', 'dev-001']);
    let state = apply(start, attacker, { type: 'DECLARE_BATTLE', city: 2 });
    const guardian = inCity(state, attacker)[0] as CardInstance;
    const merc = inCity(state, defender)[0] as CardInstance;
    state = apply(state, attacker, { type: 'DESIGNATE_VANGUARD', card: guardian.instanceId });
    state = skipOpens(state);
    // The defender has to commit, or there is nobody to fight: an unopposed
    // battle ends as a stalemate with no damage exchanged at all. §11 ③.
    const theirs = inCity(state, defender);
    state = commitThen(
      state,
      theirs.map((card) => ({ player: defender, card: card.instanceId })),
    );
    expect(state.battle?.step).toBe('damage');

    // Guardian has Power 2; assigning 1 leaves damage unspent.
    const short = engine.reduce(state, attacker, {
      type: 'ASSIGN_DAMAGE',
      card: guardian.instanceId,
      hits: [{ target: merc.instanceId, amount: 1 }],
    });
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.error.rule).toBe('§11');

    // And it cannot be spent on your own side.
    const friendly = engine.reduce(state, attacker, {
      type: 'ASSIGN_DAMAGE',
      card: guardian.instanceId,
      hits: [{ target: guardian.instanceId, amount: 2 }],
    });
    expect(friendly.ok).toBe(false);
  });

  it('hands the city over to a defender who will not fight for it', () => {
    // §12 — the result counts the two sides that *fought*. A defender may look
    // at what is coming and commit nobody; their characters stay standing, but
    // they took no part, and the city goes.
    const { state: start, attacker, defender } = withGarrison(['dev-001'], ['dev-003']);
    let state = apply(start, attacker, { type: 'DECLARE_BATTLE', city: 2 });
    const lead = inCity(state, attacker)[0] as CardInstance;
    const bystander = inCity(state, defender)[0] as CardInstance;
    state = apply(state, attacker, { type: 'DESIGNATE_VANGUARD', card: lead.instanceId });
    state = skipOpens(state);

    const handBefore = zoneSize(state, attacker, 'hand');
    state = commitThen(state);

    expect(state.battle).toBeNull();
    // Their Guardian is untouched — it simply did not fight.
    expect(state.cards[bystander.instanceId]?.zone).toBe('city');
    expect(state.cards[bystander.instanceId]?.damage).toBe(0);
    // And the city is taken, with the draw that comes with it.
    expect(state.cities[2]?.occupiedBy).toBe(attacker);
    expect(zoneSize(state, attacker, 'hand')).toBe(handBefore + 2);
  });

  it('counts only the fighters, not bystanders, when the attack is beaten', () => {
    // The mirror of the above: the attacker's vanguard dies while they have
    // another character standing in the city. It still counts as repelled,
    // because the one that fought is gone.
    const { state: start, attacker, defender } = withGarrison(['dev-001', 'dev-001'], ['dev-003']);
    let state = apply(start, attacker, { type: 'DECLARE_BATTLE', city: 2 });
    const [lead, spare] = inCity(state, attacker) as CardInstance[];
    const guardian = inCity(state, defender)[0] as CardInstance;
    state = apply(state, attacker, {
      type: 'DESIGNATE_VANGUARD',
      card: (lead as CardInstance).instanceId,
    });
    state = skipOpens(state);
    state = commitThen(state, [{ player: defender, card: guardian.instanceId }]);

    // Only one character a side is *committed*, so each strike has a single
    // enemy and neither assignment is a choice — the bystander is not a
    // participant and can never be hit. The engine resolves both.
    expect(state.battle).toBeNull();
    expect(state.cards[(lead as CardInstance).instanceId]?.zone).toBe('trash');
    // The spare never fought and is untouched, but it does not save the attack.
    expect(state.cards[(spare as CardInstance).instanceId]?.zone).toBe('city');
    expect(state.cities[2]?.occupiedBy).toBeNull();
  });

  it('reports who dealt the damage, not who took it', () => {
    // The band resolves after everyone has assigned, so the striker has to be
    // carried along with the assignment or the event blames the victim.
    const { state: start, attacker, defender } = withGarrison(['dev-003'], ['dev-001']);
    let state = apply(start, attacker, { type: 'DECLARE_BATTLE', city: 2 });
    const guardian = inCity(state, attacker)[0] as CardInstance;
    const merc = inCity(state, defender)[0] as CardInstance;
    state = apply(state, attacker, { type: 'DESIGNATE_VANGUARD', card: guardian.instanceId });
    state = skipOpens(state);

    // One enemy each, so both assignments are forced and the engine spends
    // them itself — the last commitment is what carries the whole exchange,
    // and its events are where the strikes are reported.
    const last = engine.reduce(state, defender, {
      type: 'COMMIT_CHARACTER',
      card: merc.instanceId,
    });
    if (!last.ok) throw new Error('expected the commitment to land');
    const after = last;

    const dealt = after.value.events.filter((e) => e.type === 'DAMAGE_DEALT');
    expect(dealt.length).toBe(2);
    for (const event of dealt) {
      expect(event.source, 'a card cannot damage itself').not.toBe(event.target);
    }
    expect(
      dealt.some((e) => e.source === guardian.instanceId && e.target === merc.instanceId),
    ).toBe(true);
  });

  it('agrees with the reducer at every step of a battle', () => {
    // The general agreement test never reaches a battle — it only ends turns —
    // so the invariant is checked again here, walking a fight to its end and
    // verifying at each step that everything offered is accepted.
    const { state: start, attacker } = withGarrison(
      ['dev-001', 'dev-002', 'dev-003'],
      ['dev-001', 'dev-002'],
    );
    let state = apply(start, attacker, { type: 'DECLARE_BATTLE', city: 2 });

    for (let step = 0; step < 40 && state.battle; step++) {
      const waiting = state.battle.waitingOn;

      for (const seat of state.seats) {
        for (const action of engine.legalActions(state, seat)) {
          const result = engine.reduce(state, seat, action);
          expect(
            result.ok,
            `${seat} ${action.type} at step ${state.battle?.step} should be accepted`,
          ).toBe(true);
        }
      }

      // The seat not being waited on gets nothing but conceding.
      const idle = state.seats.find((seat) => seat !== waiting) as PlayerId;
      expect(engine.legalActions(state, idle)).toEqual([{ type: 'CONCEDE' }]);

      // Take a real move to push the battle along.
      const next = engine.legalActions(state, waiting).find((action) => action.type !== 'CONCEDE');
      if (!next) break;
      state = apply(state, waiting, next);
    }

    // It reached a conclusion rather than stalling.
    expect(state.battle).toBeNull();
  });

  it('leaves the city free when the attack is called off before it starts', () => {
    // Rules.md §11 ① — naming no vanguard "ends the Battle phase", and nothing
    // has been locked, opened or struck by then. The city's one battle a turn
    // (§10 ④(4)) is for a fight that happened, so backing out at the only step
    // that offers it must not cost the area for the rest of the turn.
    const { state: start, attacker } = withGarrison(['dev-001', 'dev-003'], ['dev-001']);
    let state = apply(start, attacker, { type: 'DECLARE_BATTLE', city: 2 });
    state = apply(state, attacker, { type: 'BATTLE_PASS' });

    expect(state.battle).toBeNull();
    expect(state.turn.battledCities).not.toContain(2);
    expect(engine.reduce(state, attacker, { type: 'DECLARE_BATTLE', city: 2 }).ok).toBe(true);
  });

  it('keeps the city awake even though the attack was called off', () => {
    // §5 — being attacked is what turns a city face up, and it stays that way.
    // So declaring and backing out changes nothing a second declaration would
    // find: there is no loop here worth exploiting.
    const { state: start, attacker } = withGarrison(['dev-001', 'dev-003'], ['dev-001']);
    let state = apply(start, attacker, { type: 'DECLARE_BATTLE', city: 2 });
    state = apply(state, attacker, { type: 'BATTLE_PASS' });
    expect(state.cities[2]?.faceUp).toBe(true);
  });

  it('will not let the same city be battled twice in a turn', () => {
    // The defender outnumbers the attacker, so the attack is repelled and
    // nobody takes the city — otherwise the second declaration is refused for
    // occupying it (§10) and this would never reach the once-per-city rule.
    const { state: start, attacker } = withGarrison(['dev-001'], ['dev-001', 'dev-003']);
    let state = apply(start, attacker, { type: 'DECLARE_BATTLE', city: 2 });

    // Naming the vanguard is what commits the attack, and what spends the city.
    const lead = engine
      .legalActions(state, attacker)
      .find((action) => action.type === 'DESIGNATE_VANGUARD');
    state = apply(state, attacker, lead as GameAction);
    expect(state.turn.battledCities).toContain(2);

    // Run it out, so the re-declaration is attempted from Main as it would be.
    for (let guard = 0; guard < 24 && state.battle; guard++) {
      const waiting = state.battle.waitingOn;
      const next = engine.legalActions(state, waiting).find((action) => action.type !== 'CONCEDE');
      if (!next) break;
      state = apply(state, waiting, next);
    }
    expect(state.battle).toBeNull();
    expect(state.cities[2]?.occupiedBy).not.toBe(attacker);

    const again = engine.reduce(state, attacker, { type: 'DECLARE_BATTLE', city: 2 });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('ALREADY_ACTED');
  });

  it('will not let you attack a city you already occupy', () => {
    const { state: start, attacker } = withGarrison(['dev-001'], [], 2);
    const state = {
      ...start,
      cities: start.cities.map((c) => (c.index === 2 ? { ...c, occupiedBy: attacker } : c)),
    };
    const result = engine.reduce(state, attacker, { type: 'DECLARE_BATTLE', city: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ILLEGAL_TARGET');
  });
});
