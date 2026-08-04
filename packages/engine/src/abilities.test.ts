import { beforeEach, describe, expect, it } from 'vitest';
import { catalogueRegistry } from './data/registry.js';
import { createEngine, type Engine } from './engine.js';
import { asCardDefId, asMatchId, asPlayerId, type CardInstanceId, type PlayerId } from './ids.js';
import { cannotAttack, hpOf, moveOf, powerOf, turnOrdinal } from './rules.js';
import type { CardInstance, GameAction, GameEvent, GameState } from './types.js';
import { zoneSize } from './zones.js';

/**
 * What the cards do. Rules.md §13.
 *
 * These run against the *real* card database rather than the placeholder
 * fixtures, because the thing under test is the printed card: if BK1-010's
 * entry stops matching the line printed on Griffith, a test built on invented
 * cards would happily keep passing.
 */

const ALICE = asPlayerId('alice');
const BOB = asPlayerId('bob');

const registry = catalogueRegistry();
let engine: Engine;

beforeEach(() => {
  engine = createEngine(registry);
});

/** A legal deck of one repeated card, which is all these tests need to deal. */
const deckOf = (defId: string, count = 45): string[] => Array.from({ length: count }, () => defId);

function started(): GameState {
  const match = engine.createMatch({
    matchId: asMatchId('abilities'),
    seed: 7,
    // BK1-001 Mercenary: Level 0, no ability, so nothing here is incidental.
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

/** Stands a card face up in a city, taking it from that player's hand. */
function place(
  state: GameState,
  player: PlayerId,
  defId: string,
  city: number,
  options: { faceUp?: boolean } = {},
): { state: GameState; card: CardInstanceId } {
  const spare = Object.values(state.cards).find(
    (card) => card.controller === player && card.zone === 'hand',
  );
  if (!spare) throw new Error('no card left in hand to place');

  const placed: CardInstance = {
    ...spare,
    defId: asCardDefId(defId),
    zone: 'city',
    cityIndex: city,
    faceUp: options.faceUp ?? true,
    locked: false,
    damage: 0,
  };
  return {
    state: { ...state, cards: { ...state.cards, [spare.instanceId]: placed } },
    card: spare.instanceId,
  };
}

const cardOf = (state: GameState, id: CardInstanceId): CardInstance => {
  const card = state.cards[id];
  if (!card) throw new Error('card vanished');
  return card;
};

const power = (state: GameState, id: CardInstanceId): number =>
  powerOf({ registry }, state, cardOf(state, id));
const hp = (state: GameState, id: CardInstanceId): number =>
  hpOf({ registry }, state, cardOf(state, id));

describe('printed abilities (Rules.md §13)', () => {
  it('carries the printed line beside the behaviour, for every card that has one', () => {
    // The text is what the player reads and the entry is what the engine
    // runs; keeping them in the same place is what makes a drift visible.
    const withBehaviour = registry.all().filter((def) => (def.abilities?.length ?? 0) > 0);
    expect(withBehaviour.length).toBeGreaterThan(0);
    for (const def of withBehaviour) {
      expect(def.text, def.id).toBeTruthy();
      for (const ability of def.abilities ?? []) {
        expect(ability.text, def.id).toBeTruthy();
      }
    }
  });

  it('leaves a card with no entry doing nothing at all', () => {
    // A card whose behaviour has not been written stays inert rather than
    // being approximated. Docs/CardData.md tracks what is outstanding.
    const plain = registry.get(asCardDefId('BK1-001'));
    expect(plain.abilities).toBeUndefined();
  });

  describe('continuous abilities are read off the board, not stored', () => {
    it('BK1-010 Griffith lifts the other Hawks in his area', () => {
      let state = started();
      const griffith = place(state, ALICE, 'BK1-010', 2);
      state = griffith.state;
      // BK1-011 Guts is a Hawk; BK1-001 Mercenary is not.
      const guts = place(state, ALICE, 'BK1-011', 2);
      state = guts.state;
      const merc = place(state, ALICE, 'BK1-001', 2);
      state = merc.state;

      const printed = registry.get(asCardDefId('BK1-011')).stats;
      expect(power(state, guts.card)).toBe((printed?.power ?? 0) + 1);
      expect(hp(state, guts.card)).toBe((printed?.hp ?? 0) + 1);

      // Not himself — "other" Hawks.
      const his = registry.get(asCardDefId('BK1-010')).stats;
      expect(power(state, griffith.card)).toBe(his?.power ?? 0);
      // Not a Mercenary, whatever area it is in.
      expect(power(state, merc.card)).toBe(registry.get(asCardDefId('BK1-001')).stats?.power ?? 0);
    });

    it('stops the moment Griffith leaves the area, with nothing to undo', () => {
      let state = started();
      const griffith = place(state, ALICE, 'BK1-010', 2);
      state = griffith.state;
      const guts = place(state, ALICE, 'BK1-011', 2);
      state = guts.state;
      const boosted = power(state, guts.card);

      state = {
        ...state,
        cards: {
          ...state.cards,
          [griffith.card]: { ...cardOf(state, griffith.card), cityIndex: 4 },
        },
      };
      expect(power(state, guts.card)).toBe(boosted - 1);
    });

    it('does not reach the Neo Band, who are a different band', () => {
      let state = started();
      state = place(state, ALICE, 'BK1-010', 2).state;
      // BK4-020 is a NeoHawk; its token is `neohawk`, not `hawk`.
      const neo = registry.all().find((def) => def.subtypes?.includes('neohawk'));
      expect(neo).toBeDefined();
      const placed = place(state, ALICE, (neo as { id: string }).id, 2);
      state = placed.state;
      expect(power(state, placed.card)).toBe(neo?.stats?.power ?? 0);
    });

    it('BK1-014 Casca is lifted only while a Griffith is on your side', () => {
      let state = started();
      const casca = place(state, ALICE, 'BK1-014', 2);
      state = casca.state;
      const printed = registry.get(asCardDefId('BK1-014')).stats;
      expect(power(state, casca.card)).toBe(printed?.power ?? 0);
      expect(moveOf({ registry }, state, cardOf(state, casca.card))).toBe(printed?.move ?? 0);

      // Any Griffith, anywhere on her side — BK1-009 is one too.
      state = place(state, ALICE, 'BK1-009', 0).state;
      expect(power(state, casca.card)).toBe((printed?.power ?? 0) + 1);
      expect(moveOf({ registry }, state, cardOf(state, casca.card))).toBe((printed?.move ?? 0) + 1);
    });

    it('does not lift Casca from the opponent’s Griffith', () => {
      let state = started();
      const casca = place(state, ALICE, 'BK1-014', 2);
      state = casca.state;
      state = place(state, BOB, 'BK1-009', 2).state;
      expect(power(state, casca.card)).toBe(registry.get(asCardDefId('BK1-014')).stats?.power ?? 0);
    });

    it('never takes a number below zero', () => {
      // BK1-156 Operation Liberation is -2/-0, and plenty of characters have
      // less than 2 Power. A negative would heal whatever it struck.
      let state = started();
      state = {
        ...state,
        cities: state.cities.map((city) =>
          city.index === 2 ? { ...city, faceUp: true, occupiedBy: BOB } : city,
        ),
      };
      state = place(state, ALICE, 'BK1-156', 2).state;
      const victim = place(state, BOB, 'BK1-001', 2);
      state = victim.state;

      expect(registry.get(asCardDefId('BK1-001')).stats?.power).toBeLessThan(2);
      expect(power(state, victim.card)).toBe(0);
    });

    it('BK1-020 Pippin cannot attack the turn it is opened, and can after', () => {
      let state = started();
      const pippin = place(state, ALICE, 'BK1-020', 2, { faceUp: false });
      state = pippin.state;
      // Not opened yet, so nothing is stopping it.
      expect(cannotAttack({ registry }, state, cardOf(state, pippin.card))).toBe(false);

      state = {
        ...state,
        cards: {
          ...state.cards,
          [pippin.card]: {
            ...cardOf(state, pippin.card),
            faceUp: true,
            counters: { openedOnTurn: turnOrdinal(state) },
          },
        },
      };
      expect(cannotAttack({ registry }, state, cardOf(state, pippin.card))).toBe(true);
    });
  });

  describe('triggered abilities fire once and write their result down', () => {
    it('BK1-017 Corkus takes a card off the opponent when it is opened', () => {
      let state = started();
      const set = place(state, ALICE, 'BK1-017', 2, { faceUp: false });
      state = set.state;
      // Their turn, their Open step, and City Level high enough to pay for it.
      state = openable(state, ALICE, set.card);

      const before = zoneSize(state, BOB, 'hand');
      const open = engine
        .legalActions(state, ALICE)
        .find((action) => action.type === 'OPEN_CARD' && action.card === set.card);
      expect(open, 'Corkus should be openable').toBeDefined();
      state = apply(state, ALICE, open as GameAction);

      expect(zoneSize(state, BOB, 'hand')).toBe(before - 1);
      expect(cardOf(state, set.card).faceUp).toBe(true);
    });

    it('BK1-003 Moonlight Raiders goes back to hand at the end of the turn', () => {
      let state = started();
      // Whoever has the turn: the ability is written from its controller's
      // side, and which seat deals first is the shuffle's business.
      const owner = state.turn.activePlayer;
      const raiders = place(state, owner, 'BK1-003', 2);
      state = raiders.state;

      expect(cardOf(state, raiders.card).zone).toBe('city');
      state = endTurn(state, owner);
      expect(cardOf(state, raiders.card).zone).toBe('hand');
    });

    it('BK1-003 comes home at the end of ANY turn, not just its own', () => {
      // "The turn", not "your turn". A defender may open during a battle on
      // the attacker's turn (Rules.md §11 ②), and a card that came down then
      // goes back at the end of *that* turn rather than waiting a full round.
      let state = started();
      const active = state.turn.activePlayer;
      const other = state.seats.find((seat) => seat !== active) as PlayerId;

      const raiders = place(state, other, 'BK1-003', 2);
      state = raiders.state;
      expect(cardOf(state, raiders.card).zone).toBe('city');

      // The turn belongs to the *other* player, and it still goes home.
      state = endTurn(state, active);
      expect(cardOf(state, raiders.card).zone).toBe('hand');
      expect(cardOf(state, raiders.card).owner).toBe(other);
    });

    it('BK1-018 Corkus draws only on its own controller’s turn', () => {
      // The mirror of BK1-003: "at the start of *your* turn" stays narrow.
      // One Corkus each, both on an area its controller holds; only the
      // player whose turn is starting should draw.
      let state = started();
      const active = state.turn.activePlayer;
      const other = state.seats.find((seat) => seat !== active) as PlayerId;
      state = {
        ...state,
        cities: state.cities.map((city) => {
          if (city.index === 1) return { ...city, faceUp: true, occupiedBy: active };
          if (city.index === 3) return { ...city, faceUp: true, occupiedBy: other };
          return city;
        }),
      };
      const mine = place(state, active, 'BK1-018', 1);
      state = mine.state;
      const theirs = place(state, other, 'BK1-018', 3);
      state = theirs.state;

      const seen: GameEvent[] = [];
      state = endTurn(state, active, seen);

      // The turn passed to `other`, so their Corkus went off and ours did not.
      const drew = seen.filter((event) => event.type === 'ABILITY_RESOLVED');
      expect(drew.map((event) => event.card)).toEqual([theirs.card]);
    });

    it('BK1-020 Pippin can attack once the turn it was opened is over', () => {
      // "This turn" has to mean this turn, not this round: turn numbers count
      // rounds, so both seats share one.
      let state = started();
      const active = state.turn.activePlayer;
      const set = place(state, active, 'BK1-020', 2, { faceUp: false });
      state = set.state;
      state = openable(state, active, set.card);

      const open = engine
        .legalActions(state, active)
        .find((action) => action.type === 'OPEN_CARD' && action.card === set.card);
      expect(open, 'Pippin should be openable').toBeDefined();
      state = apply(state, active, open as GameAction);
      expect(cannotAttack({ registry }, state, cardOf(state, set.card))).toBe(true);

      // The opponent's turn is a different turn, and so is the next of ours.
      state = endTurn(state, active);
      expect(cannotAttack({ registry }, state, cardOf(state, set.card))).toBe(false);
    });

    it('clears an until-end-of-turn boost with the damage', () => {
      let state = started();
      const owner = state.turn.activePlayer;
      const squad = place(state, owner, 'BK1-002', 2);
      state = squad.state;
      state = {
        ...state,
        cards: {
          ...state.cards,
          [squad.card]: { ...cardOf(state, squad.card), counters: { boostPower: 1, boostHp: 1 } },
        },
      };
      const printed = registry.get(asCardDefId('BK1-002')).stats;
      expect(power(state, squad.card)).toBe((printed?.power ?? 0) + 1);

      state = endTurn(state, owner);
      expect(power(state, squad.card)).toBe(printed?.power ?? 0);
      expect(hp(state, squad.card)).toBe(printed?.hp ?? 0);
    });
  });
});

describe('abilities that ask who they are pointed at (Rules.md §13)', () => {
  /** Stands a targeting Effect face-down beside two characters to aim at. */
  function withRider(): {
    state: GameState;
    player: PlayerId;
    rider: CardInstanceId;
    friend: CardInstanceId;
    foe: CardInstanceId;
  } {
    let state = started();
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const friend = place(state, player, 'BK1-001', 2);
    state = friend.state;
    const foe = place(state, other, 'BK1-001', 2);
    state = foe.state;
    // Somebody in another area, who must not be offered: "in this area".
    state = place(state, player, 'BK1-001', 4).state;

    const rider = place(state, player, 'BK1-004', 2, { faceUp: false });
    state = openable(rider.state, player, rider.card);
    return { state, player, rider: rider.card, friend: friend.card, foe: foe.card };
  }

  const openOf = (state: GameState, player: PlayerId, card: CardInstanceId) =>
    engine
      .legalActions(state, player)
      .find(
        (action): action is Extract<GameAction, { type: 'OPEN_CARD' }> =>
          action.type === 'OPEN_CARD' && action.card === card,
      );

  it('offers a target with the open, so the client has something legal to send', () => {
    const { state, player, rider } = withRider();
    const open = openOf(state, player, rider);
    expect(open, 'the Rider should be openable').toBeDefined();
    expect(open?.targets?.length).toBe(1);
  });

  it('lifts whoever the player actually chose', () => {
    const { state, player, rider, foe } = withRider();
    const open = openOf(state, player, rider);
    // Aim it somewhere other than the suggestion: the choice is the player's.
    const next = apply(state, player, { ...(open as GameAction), targets: [foe] } as GameAction);

    const printed = registry.get(asCardDefId('BK1-001')).stats;
    expect(power(next, foe)).toBe((printed?.power ?? 0) + 1);
    expect(hp(next, foe)).toBe((printed?.hp ?? 0) + 1);
  });

  it('only offers characters in the same area', () => {
    const { state, player, rider, friend, foe } = withRider();
    const open = openOf(state, player, rider);
    const elsewhere = Object.values(state.cards).find(
      (card) => card.zone === 'city' && card.cityIndex === 4,
    );
    expect(elsewhere).toBeDefined();

    const aimAway = engine.reduce(state, player, {
      ...(open as Extract<GameAction, { type: 'OPEN_CARD' }>),
      targets: [(elsewhere as CardInstance).instanceId],
    });
    expect(aimAway.ok).toBe(false);
    if (!aimAway.ok) expect(aimAway.error.code).toBe('ILLEGAL_TARGET');

    // Both of the ones standing in the area are fair game — the card says
    // "target 1 character", not "one of yours".
    for (const pick of [friend, foe]) {
      const result = engine.reduce(state, player, {
        ...(open as Extract<GameAction, { type: 'OPEN_CARD' }>),
        targets: [pick],
      });
      expect(result.ok, `${pick} should be targetable`).toBe(true);
    }
  });

  it('can be pointed at itself when it is the only character there', () => {
    // The card being opened is a character standing in that area by the time
    // its own ability resolves, so "target 1 character in this area" reaches
    // it. The offer is computed while it is still face-down, which is what
    // made a lone Rider ask for nothing and then do nothing.
    let state = started();
    const player = state.turn.activePlayer;
    const rider = place(state, player, 'BK1-004', 2, { faceUp: false });
    state = openable(rider.state, player, rider.card);

    const open = openOf(state, player, rider.card);
    expect(open?.targets).toEqual([rider.card]);

    const next = apply(state, player, open as GameAction);
    const printed = registry.get(asCardDefId('BK1-004')).stats;
    expect(power(next, rider.card)).toBe((printed?.power ?? 0) + 1);
  });

  it('opens anyway when there is nobody to point at', () => {
    // Rules.md §13 resolves what it can. BK1-026 is an Effect rather than a
    // character, so in an empty area it has nobody to point at — not even
    // itself — and is still a card that was opened at the cost it costs.
    let state = started();
    const player = state.turn.activePlayer;
    const spell = place(state, player, 'BK1-026', 2, { faceUp: false });
    state = openable(spell.state, player, spell.card);

    const open = openOf(state, player, spell.card);
    expect(open, 'it should still be openable').toBeDefined();
    expect(open?.targets).toBeUndefined();

    const next = apply(state, player, open as GameAction);
    // A Normal Effect resolves and goes to the Trash. Rules.md §3.
    expect(next.cards[spell.card]?.zone).toBe('trash');
  });
});

describe('a buffed attacker can actually be assigned', () => {
  it('BK1-012 Guts strikes for its boosted Power, and the view says so', () => {
    // The reported bug: Guts leads an attack, the trigger lifts him, and the
    // damage step then wants a total the client did not know about — so the
    // assignment can never balance and the battle cannot be finished.
    let state = started();
    const attacker = state.turn.activePlayer;
    const defender = state.seats.find((seat) => seat !== attacker) as PlayerId;

    const guts = place(state, attacker, 'BK1-012', 2);
    state = guts.state;
    // Enough HP on the other side to absorb everything he now hits for.
    state = place(state, defender, 'BK1-001', 2).state;
    state = place(state, defender, 'BK1-001', 2).state;
    state = place(state, defender, 'BK1-001', 2).state;
    state = place(state, defender, 'BK1-001', 2).state;
    state = { ...state, turn: { ...state.turn, priorityPlayer: attacker } };
    state = atMain(state);

    const printed = registry.get(asCardDefId('BK1-012')).stats?.power ?? 0;
    state = apply(state, attacker, { type: 'DECLARE_BATTLE', city: 2 });
    state = apply(state, attacker, { type: 'DESIGNATE_VANGUARD', card: guts.card });

    // The trigger has fired: he leads, so he is lifted.
    expect(power(state, guts.card)).toBe(printed + 1);
    const seen = engine.viewFor(state, attacker).cards[guts.card];
    expect(seen && 'current' in seen ? seen.current?.power : undefined).toBe(printed + 1);

    // Run the battle to the damage step. The defender has to actually fight:
    // a battle nobody joins ends as a stalemate with no damage at all (§11 ③).
    for (let guard = 0; guard < 16 && state.battle?.step !== 'damage'; guard++) {
      const waiting = state.battle?.waitingOn;
      if (!waiting) break;
      const actions = engine.legalActions(state, waiting);
      const join = actions.find(
        (action) => action.type === 'COMMIT_CHARACTER' && waiting === defender,
      );
      state = apply(state, waiting, join ?? { type: 'BATTLE_PASS' });
    }
    expect(state.battle?.step).toBe('damage');

    const assign = engine
      .legalActions(state, attacker)
      .find((action) => action.type === 'ASSIGN_DAMAGE');
    expect(assign, 'the engine should offer an assignment').toBeDefined();
    const offered = assign as Extract<GameAction, { type: 'ASSIGN_DAMAGE' }>;
    expect(offered.card).toBe(guts.card);

    // What it offers has to add up to the boosted Power, or a client that
    // trusts it sends something the reducer will refuse.
    const total = offered.hits.reduce((sum, hit) => sum + hit.amount, 0);
    expect(total).toBe(printed + 1);
    expect(engine.reduce(state, attacker, offered).ok).toBe(true);
  });
});

describe('the client is told the numbers the engine will use', () => {
  it('sends a face-up character’s current stats, not its printed ones', () => {
    // The damage step spends the *current* Power exactly (Rules.md §11 ④). A
    // client reading printed Power off the card database can never balance an
    // assignment for a character an ability has moved — the Strike button
    // simply never becomes right.
    let state = started();
    const griffith = place(state, ALICE, 'BK1-010', 2);
    state = griffith.state;
    const guts = place(state, ALICE, 'BK1-011', 2);
    state = guts.state;

    const view = engine.viewFor(state, ALICE);
    const seen = view.cards[guts.card];
    const printed = registry.get(asCardDefId('BK1-011')).stats;

    expect(seen && 'current' in seen ? seen.current : undefined).toEqual({
      power: (printed?.power ?? 0) + 1,
      hp: (printed?.hp ?? 0) + 1,
      move: printed?.move ?? 0,
    });
  });

  it('leaves a card in hand without them, having no board to be moved by', () => {
    const state = started();
    const inHand = (state.zoneOrder[`${ALICE}:hand`] ?? [])[0];
    expect(inHand).toBeDefined();
    const seen = engine.viewFor(state, ALICE).cards[inHand as CardInstanceId];
    expect(seen && 'current' in seen ? seen.current : undefined).toBeUndefined();
  });
});

/** Puts the turn on the Main phase, where a battle is declared. §10 ④(4). */
function atMain(state: GameState): GameState {
  const phaseIndex = state.phases.findIndex((phase) => phase.id === 'main');
  return { ...state, turn: { ...state.turn, phaseIndex } };
}

/** Puts the turn on the Open step with the City Level this card needs. */
function openable(state: GameState, player: PlayerId, card: CardInstanceId): GameState {
  const level = registry.get(cardOf(state, card).defId).level ?? 0;
  const phaseIndex = state.phases.findIndex((phase) => phase.id === 'open');
  return {
    ...state,
    // City Level is the count of face-up cities, so turn up as many as the
    // card's Level needs. Rules.md §5.
    cities: state.cities.map((city, index) => (index < level ? { ...city, faceUp: true } : city)),
    turn: { ...state.turn, phaseIndex, activePlayer: player, priorityPlayer: player },
  };
}

/** Runs the turn out, discarding down to the limit if the End phase asks. */
function endTurn(state: GameState, player: PlayerId, collect?: GameEvent[]): GameState {
  let next = state;
  const step = (action: GameAction): void => {
    const result = engine.reduce(next, next.turn.priorityPlayer, action);
    if (!result.ok) throw new Error(`${action.type} rejected: ${result.error.message}`);
    collect?.push(...result.value.events);
    next = result.value.state;
  };

  for (let guard = 0; guard < 24; guard++) {
    if (next.turn.activePlayer !== player) return next;
    const actions = engine.legalActions(next, next.turn.priorityPlayer);
    const discard = actions.find((action) => action.type === 'DISCARD_CARD');
    const end = actions.find((action) => action.type === 'END_PHASE');
    if (discard) step(discard);
    else if (end) step(end);
    else return next;
  }
  return next;
}
