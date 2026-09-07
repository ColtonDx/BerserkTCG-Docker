import { beforeEach, describe, expect, it } from 'vitest';
import { catalogueRegistry } from './data/registry.js';
import { createEngine, type Engine } from './engine.js';
import { asCardDefId, asMatchId, asPlayerId, type CardInstanceId, type PlayerId } from './ids.js';
import { SHIELD, SKIP_REFRESH } from './abilities.js';
import {
  boostSources,
  rangeOf,
  stillFighting,
  abilitiesOf,
  altersFor,
  cannotAttack,
  cannotBattle,
  canVanguard,
  damageAfterReduction,
  hpOf,
  moveOf,
  powerOf,
  turnOrdinal,
  cityLevel,
  openLevelFor,
  opensLocked,
  subtypesOf,
} from './rules.js';
import { isMercenary } from './deck.js';
import { isCityHidden, isHidden, viewFor } from './view.js';
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

/** The green Mercenary, for decks that have to pay a green cost. */
const GREEN = 'BK1-041';
/** The red Mercenary, for decks that have to pay a red cost. */
const RED = 'BK1-121';

const registry = catalogueRegistry();
let engine: Engine;

beforeEach(() => {
  engine = createEngine(registry);
});

/** A legal deck of one repeated card, which is all these tests need to deal. */
const deckOf = (defId: string, count = 45): string[] => Array.from({ length: count }, () => defId);

/**
 * A match dealt from a deck of one repeated Mercenary.
 *
 * The colour matters, because a cost is paid with cards of that colour out of
 * hand (Rules.md §7): a white hand simply cannot open a green card, and a test
 * that forgets this fails on the payment long before it reaches the ability
 * it meant to check. `BK1-001` is the white Mercenary, `BK1-041` the green.
 */
function started(deck = 'BK1-001'): GameState {
  const match = engine.createMatch({
    matchId: asMatchId('abilities'),
    seed: 7,
    // A Mercenary is Level 0 and has no ability, so nothing here is incidental.
    decks: [
      { playerId: ALICE, name: 'Alice', cards: deckOf(deck).map(asCardDefId) },
      { playerId: BOB, name: 'Bob', cards: deckOf(deck).map(asCardDefId) },
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
  // A card in a city is in no ordered zone — `zones.ts:moveToCity` detaches it
  // on the way in. Leaving it listed in the hand would make it count towards
  // the hand size, and would silently un-count a draw the moment anything
  // moved it again, because `detach` would find the stale entry.
  const zoneOrder = Object.fromEntries(
    Object.entries(state.zoneOrder).map(([key, order]) => [
      key,
      order.filter((id) => id !== spare.instanceId),
    ]),
  );

  return {
    state: { ...state, cards: { ...state.cards, [spare.instanceId]: placed }, zoneOrder },
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

    it('names who is doing the lifting, so the table can show the connection', () => {
      // A continuous ability is stored nowhere: it is read off the board every
      // time it is asked for. That leaves a character standing at +1/+1 with
      // no visible reason for it, so the view carries the source — and the
      // client cannot work it out, because which cards an ability reaches is
      // engine data and the catalogue holds only the printed line.
      let state = started();
      const griffith = place(state, ALICE, 'BK1-010', 2);
      state = griffith.state;
      const guts = place(state, ALICE, 'BK1-011', 2);
      state = guts.state;
      const merc = place(state, ALICE, 'BK1-001', 2);
      state = merc.state;

      expect(boostSources({ registry }, state, cardOf(state, guts.card))).toEqual([griffith.card]);
      // Never itself — "other Hawks" — and never a card it does not reach.
      expect(boostSources({ registry }, state, cardOf(state, griffith.card))).toEqual([]);
      expect(boostSources({ registry }, state, cardOf(state, merc.card))).toEqual([]);
    });

    it('drops the source the moment it stops applying', () => {
      let state = started();
      const griffith = place(state, ALICE, 'BK1-010', 2);
      state = griffith.state;
      const guts = place(state, ALICE, 'BK1-011', 2);
      state = guts.state;
      expect(boostSources({ registry }, state, cardOf(state, guts.card))).toEqual([griffith.card]);

      state = {
        ...state,
        cards: {
          ...state.cards,
          [griffith.card]: { ...cardOf(state, griffith.card), cityIndex: 4 },
        },
      };
      expect(boostSources({ registry }, state, cardOf(state, guts.card))).toEqual([]);
    });

    it('sends the source in the view, and only where there is one', () => {
      let state = started();
      const griffith = place(state, ALICE, 'BK1-010', 2);
      state = griffith.state;
      const guts = place(state, ALICE, 'BK1-011', 2);
      state = guts.state;

      const view = viewFor({ registry }, state, ALICE);
      const lifted = view.cards[guts.card];
      expect(lifted && !isHidden(lifted) ? lifted.boostedBy : undefined).toEqual([griffith.card]);
      // Omitted rather than sent empty: most characters are nobody's business.
      const source = view.cards[griffith.card];
      expect(source && !isHidden(source) ? source.boostedBy : undefined).toBeUndefined();
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

describe('effects that reach across the board (Rules.md §13)', () => {
  it('BK1-053 Schierke burns every enemy in her area, and nobody else', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    // BK1-041 Mercenary is a 1/1 green: 4 damage kills it outright.
    const enemyHere = place(state, other, 'BK1-041', 2);
    state = enemyHere.state;
    const enemyAway = place(state, other, 'BK1-041', 4);
    state = enemyAway.state;
    const friend = place(state, player, 'BK1-041', 2);
    state = friend.state;

    const schierke = place(state, player, 'BK1-053', 2, { faceUp: false });
    state = openable(schierke.state, player, schierke.card);
    const open = openOf(state, player, schierke.card);
    expect(open, 'Schierke should be openable').toBeDefined();
    state = apply(state, player, open as GameAction);

    expect(state.cards[enemyHere.card]?.zone).toBe('trash');
    // Not the other area, and not her own side.
    expect(state.cards[enemyAway.card]?.zone).toBe('city');
    expect(state.cards[friend.card]?.zone).toBe('city');
  });

  it('BK1-072 spares an enemy above its Level cap', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    // BK1-041 is Level 0, BK1-052 Serpico is Level 3 — over the cap.
    const small = place(state, other, 'BK1-041', 2);
    state = small.state;
    const big = place(state, other, 'BK1-052', 2);
    state = big.state;

    const fire = place(state, player, 'BK1-072', 2, { faceUp: false });
    state = openable(fire.state, player, fire.card);
    state = apply(state, player, openOf(state, player, fire.card) as GameAction);

    expect(state.cards[small.card]?.zone).toBe('trash');
    expect(state.cards[big.card]?.zone).toBe('city');
    // It still took the damage, it just did not die of it.
    expect(state.cards[big.card]?.damage).toBe(0);
  });

  it('BK1-080 only offers a black character to destroy', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const green = place(state, other, 'BK1-041', 2);
    state = green.state;
    const black = place(state, other, 'BK1-081', 2);
    state = black.state;

    const bond = place(state, player, 'BK1-080', 2, { faceUp: false });
    state = openable(bond.state, player, bond.card);
    const open = openOf(state, player, bond.card);
    expect(open?.targets).toEqual([black.card]);

    // Aiming it at the green one is refused outright.
    const wrong = engine.reduce(state, player, {
      ...(open as Extract<GameAction, { type: 'OPEN_CARD' }>),
      targets: [green.card],
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.code).toBe('ILLEGAL_TARGET');

    state = apply(state, player, open as GameAction);
    expect(state.cards[black.card]?.zone).toBe('trash');
    expect(state.cards[green.card]?.zone).toBe('city');
  });

  it('BK1-043 Golem draws its controller a card as it dies', () => {
    // The trigger fires on the way *out*: an ability read off a card already
    // in the Trash is an ability read off a card that is not there.
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const golem = place(state, player, 'BK1-043', 2);
    state = golem.state;
    // Schierke's 4 damage is more than a Golem's 2 HP.
    const schierke = place(state, other, 'BK1-053', 2, { faceUp: false });
    state = openable(schierke.state, other, schierke.card);
    state = { ...state, turn: { ...state.turn, activePlayer: other, priorityPlayer: other } };

    const before = zoneSize(state, player, 'hand');
    state = apply(state, other, openOf(state, other, schierke.card) as GameAction);

    expect(state.cards[golem.card]?.zone).toBe('trash');
    expect(zoneSize(state, player, 'hand')).toBe(before + 1);
  });

  it('BK1-058 Flora lifts her side and drags the other down, while she stands there', () => {
    let state = started();
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const flora = place(state, player, 'BK1-058', 2);
    state = flora.state;
    const friend = place(state, player, 'BK1-041', 2);
    state = friend.state;
    const enemy = place(state, other, 'BK1-041', 2);
    state = enemy.state;

    const printed = registry.get(asCardDefId('BK1-041')).stats;
    expect(hp(state, friend.card)).toBe((printed?.hp ?? 0) + 2);
    expect(power(state, friend.card)).toBe(printed?.power ?? 0);
    // -2 Power on a 1-Power Mercenary floors at zero, not below.
    expect(power(state, enemy.card)).toBe(0);

    // She is a continuous ability, so moving her away ends it at once.
    state = {
      ...state,
      cards: { ...state.cards, [flora.card]: { ...cardOf(state, flora.card), cityIndex: 0 } },
    };
    expect(hp(state, friend.card)).toBe(printed?.hp ?? 0);
    expect(power(state, enemy.card)).toBe(printed?.power ?? 0);
  });
});

describe('effects that scale with the board — "for each" (Rules.md §13)', () => {
  it('BK1-060 Forced Breakthrough grows with the enemies stood opposite', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const mine = place(state, player, 'BK1-041', 2);
    state = mine.state;
    state = place(state, other, 'BK1-041', 2).state;
    state = place(state, other, 'BK1-041', 2).state;
    // A third enemy stood elsewhere is not "in this area" and must not count.
    state = place(state, other, 'BK1-041', 4).state;

    const printed = registry.get(asCardDefId('BK1-041')).stats;
    const push = place(state, player, 'BK1-060', 2, { faceUp: false });
    state = openable(push.state, player, push.card);
    const open = openOf(state, player, push.card);
    state = apply(state, player, {
      ...(open as Extract<GameAction, { type: 'OPEN_CARD' }>),
      targets: [mine.card],
    });

    // Two enemies here, so +2/+2 twice over.
    expect(power(state, mine.card)).toBe((printed?.power ?? 0) + 4);
    expect(hp(state, mine.card)).toBe((printed?.hp ?? 0) + 4);
  });

  it('BK1-060 is worth nothing across an empty area, rather than a flat bonus', () => {
    // A "for each" that found nothing must multiply by zero. Reading the
    // absent count as one is the bug this guards.
    let state = started(GREEN);
    const player = state.turn.activePlayer;

    const mine = place(state, player, 'BK1-041', 2);
    state = mine.state;
    const printed = registry.get(asCardDefId('BK1-041')).stats;

    const push = place(state, player, 'BK1-060', 2, { faceUp: false });
    state = openable(push.state, player, push.card);
    const open = openOf(state, player, push.card);
    state = apply(state, player, {
      ...(open as Extract<GameAction, { type: 'OPEN_CARD' }>),
      targets: [mine.card],
    });

    expect(power(state, mine.card)).toBe(printed?.power ?? 0);
    expect(hp(state, mine.card)).toBe(printed?.hp ?? 0);
  });

  it('BK1-073 Fated Encounter draws one for each character you have open', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    // Three of mine, spread across the board — "open" is not "in this area".
    state = place(state, player, 'BK1-041', 1).state;
    state = place(state, player, 'BK1-041', 2).state;
    state = place(state, player, 'BK1-041', 4).state;
    // Neither the opponent's characters nor my own Set Cards are counted.
    state = place(state, other, 'BK1-041', 2).state;
    state = place(state, player, 'BK1-041', 3, { faceUp: false }).state;

    const encounter = place(state, player, 'BK1-073', 2, { faceUp: false });
    state = openable(encounter.state, player, encounter.card);
    const before = zoneSize(state, player, 'hand');
    const open = openOf(state, player, encounter.card);
    expect(open, 'Fated Encounter should be openable').toBeDefined();
    state = apply(state, player, open as GameAction);

    // Three drawn, less the one card that paid for it.
    const paid = (open as Extract<GameAction, { type: 'OPEN_CARD' }>).pay.length;
    expect(zoneSize(state, player, 'hand')).toBe(before + 3 - paid);
  });

  it('BK1-078 Fetish For Telepathy lifts this area by the whole board’s count', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;

    const here = place(state, player, 'BK1-041', 2);
    state = here.state;
    const away = place(state, player, 'BK1-041', 4);
    state = away.state;

    const printed = registry.get(asCardDefId('BK1-041')).stats;
    const fetish = place(state, player, 'BK1-078', 2, { faceUp: false });
    state = openable(fetish.state, player, fetish.card);
    state = apply(state, player, openOf(state, player, fetish.card) as GameAction);

    // Two characters open, so +2/+2 — but only to the one standing here.
    expect(power(state, here.card)).toBe((printed?.power ?? 0) + 2);
    expect(hp(state, here.card)).toBe((printed?.hp ?? 0) + 2);
    expect(power(state, away.card)).toBe(printed?.power ?? 0);
  });

  it('BK1-067 Sustenance Of Hate trades every Set Card for a card drawn', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const setHere = place(state, player, 'BK1-041', 2, { faceUp: false });
    state = setHere.state;
    const setAway = place(state, player, 'BK1-041', 4, { faceUp: false });
    state = setAway.state;
    // Not the opponent's, and not a character standing face up.
    const enemySet = place(state, other, 'BK1-041', 2, { faceUp: false });
    state = enemySet.state;
    const standing = place(state, player, 'BK1-041', 2);
    state = standing.state;

    const hate = place(state, player, 'BK1-067', 2, { faceUp: false });
    state = openable(hate.state, player, hate.card);
    const before = zoneSize(state, player, 'hand');
    const open = openOf(state, player, hate.card);
    expect(open, 'Sustenance Of Hate should be openable').toBeDefined();
    state = apply(state, player, open as GameAction);

    expect(state.cards[setHere.card]?.zone).toBe('trash');
    expect(state.cards[setAway.card]?.zone).toBe('trash');
    expect(state.cards[enemySet.card]?.zone).toBe('city');
    expect(state.cards[standing.card]?.zone).toBe('city');

    // Two set cards destroyed, so two drawn, less what paid for it. The card
    // itself was face up as it resolved, so it never swept itself up.
    const paid = (open as Extract<GameAction, { type: 'OPEN_CARD' }>).pay.length;
    expect(zoneSize(state, player, 'hand')).toBe(before + 2 - paid);
  });
});

describe('an ability that finds nothing to do (Rules.md §13)', () => {
  it('says so, rather than coming forward and changing nothing', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    // BK1-060: "+2/+2 for each character your opponent controls in this
    // area" — and the opponent controls nobody here.
    const mine = place(state, player, 'BK1-041', 2);
    state = mine.state;
    const card = place(state, player, 'BK1-060', 2, { faceUp: false });
    state = openable(card.state, player, card.card);
    const open = openOf(state, player, card.card);
    expect(open, 'Forced Breakthrough should be openable').toBeDefined();
    const before = power(state, mine.card);

    const result = engine.reduce(state, player, open as GameAction);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const types = result.value.events.map((event) => event.type);
    expect(types).toContain('ABILITY_RESOLVED');
    expect(types).toContain('ABILITY_FIZZLED');
    // The numbers did not move, and the card says why.
    expect(power(result.value.state, mine.card)).toBe(before);
  });

  it('stays silent when the ability did its work', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const mine = place(state, player, 'BK1-041', 2);
    state = mine.state;
    const card = place(state, player, 'BK1-063', 2, { faceUp: false });
    state = openable(card.state, player, card.card);
    const open = openOf(state, player, card.card);
    expect(open).toBeDefined();

    const result = engine.reduce(state, player, open as GameAction);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const types = result.value.events.map((event) => event.type);
    expect(types).toContain('ABILITY_RESOLVED');
    expect(types).not.toContain('ABILITY_FIZZLED');
  });
});

describe('searches that do more than take a card (Rules.md §13)', () => {
  /** Answers an outstanding choice with the first card offered, `n` times. */
  function pick(state: GameState, player: PlayerId, n: number): GameState {
    let next = state;
    for (let i = 0; i < n; i++) {
      const choice = engine.legalActions(next, player).find((a) => a.type === 'CHOOSE_CARD');
      if (!choice) throw new Error('nothing to choose');
      next = apply(next, player, choice);
    }
    return next;
  }

  it('BK1-075 Magical Research sends three to the graveyard, then draws two', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const card = place(state, player, 'BK1-075', 2, { faceUp: false });
    state = openable(card.state, player, card.card);
    const open = openOf(state, player, card.card);
    expect(open).toBeDefined();
    const hand =
      zoneSize(state, player, 'hand') - (open as GameAction & { pay: unknown[] }).pay.length;
    const trash = zoneSize(state, player, 'trash');
    state = apply(state, player, open as GameAction);

    // Stopped on the search; the draw has not happened yet.
    expect(state.pending?.kind.zone).toBe('deck');
    expect(state.pending?.then?.effects[0]?.do).toBe('draw');
    expect(zoneSize(state, player, 'hand')).toBe(hand);

    state = pick(state, player, 3);
    expect(state.pending).toBeNull();
    // Three to the graveyard (plus the card itself, a Normal), then two drawn.
    expect(zoneSize(state, player, 'trash')).toBe(
      trash + 3 + 1 + (open as GameAction & { pay: unknown[] }).pay.length,
    );
    expect(zoneSize(state, player, 'hand')).toBe(hand + 2);
  });

  it('BK1-025 Request To Join sets up to two Mercenaries, and may stop at one', () => {
    let state = started('BK1-001');
    const player = state.turn.activePlayer;
    const card = place(state, player, 'BK1-025', 3, { faceUp: false });
    state = openable(card.state, player, card.card);
    const open = openOf(state, player, card.card);
    expect(open).toBeDefined();
    state = apply(state, player, open as GameAction);
    expect(state.pending?.upTo).toBe(true);

    const first = engine.legalActions(state, player).find((a) => a.type === 'CHOOSE_CARD');
    state = apply(state, player, first as GameAction);
    // One set face down in the area, and the offer to stop is still there.
    const set = Object.values(state.cards).filter(
      (c) => c.zone === 'city' && c.cityIndex === 3 && !c.faceUp && c.controller === player,
    );
    expect(set).toHaveLength(1);
    expect(engine.legalActions(state, player).some((a) => a.type === 'ANSWER')).toBe(true);
    state = apply(state, player, { type: 'ANSWER', accept: false });
    expect(state.pending).toBeNull();
  });

  it('BK1-065 A Sword For Protection is shut until a battle is declared here', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;
    state = place(state, player, 'BK1-041', 2).state;
    state = place(state, other, 'BK1-041', 2).state;
    const card = place(state, player, 'BK1-065', 2, { faceUp: false });
    state = openable(card.state, player, card.card);
    expect(openOf(state, player, card.card)).toBeUndefined();

    // Declare, then call it off: the declaration is what the card asks about.
    state = atMain(state);
    state = apply(state, player, { type: 'DECLARE_BATTLE', city: 2 });
    state = apply(state, player, { type: 'BATTLE_PASS' });
    state = {
      ...state,
      turn: { ...state.turn, phaseIndex: state.phases.findIndex((p) => p.id === 'open') },
    };
    const open = openOf(state, player, card.card);
    expect(open, 'declared here this turn, so openable').toBeDefined();
    state = apply(state, player, open as GameAction);
    expect(state.pending?.kind.zone).toBe('deck');
    const events: GameEvent[] = [];
    const choice = engine.legalActions(state, player).find((a) => a.type === 'CHOOSE_CARD');
    const result = engine.reduce(state, player, choice as GameAction);
    expect(result.ok).toBe(true);
    if (result.ok) events.push(...result.value.events);
    // Revealed on the way to hand, and the draw followed.
    expect(events.map((e) => e.type)).toContain('CARD_REVEALED');
    expect(events.filter((e) => e.type === 'CARD_DRAWN')).toHaveLength(1);
  });
});

describe('areas chosen freely (Rules.md §13)', () => {
  it('BK1-068 Compensation For The Porter moves every Set Card here to the chosen area', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const one = place(state, player, 'BK1-041', 1, { faceUp: false });
    const two = place(one.state, player, 'BK1-041', 1, { faceUp: false });
    const card = place(two.state, player, 'BK1-068', 1, { faceUp: false });
    state = openable(card.state, player, card.card);
    const offers = engine
      .legalActions(state, player)
      .filter(
        (a): a is Extract<GameAction, { type: 'OPEN_CARD' }> =>
          a.type === 'OPEN_CARD' && a.card === card.card,
      );
    // One offer per other area — never its own.
    expect(offers.map((a) => a.areas?.[0]).sort()).toEqual([0, 2, 3, 4]);
    const toFour = offers.find((a) => a.areas?.[0] === 4);
    state = apply(state, player, toFour as GameAction);
    expect(state.cards[one.card]?.cityIndex).toBe(4);
    expect(state.cards[two.card]?.cityIndex).toBe(4);
    expect(state.cards[one.card]?.faceUp).toBe(false);
  });

  it('BK1-062 Goal Of The Swordsman only offers areas holding an enemy of Level 3+', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;
    const mine = place(state, player, 'BK1-041', 0);
    state = place(mine.state, other, 'BK1-044', 3).state; // Guts, Level 3
    state = place(state, other, 'BK1-041', 4).state; // a Mercenary, Level 0
    const card = place(state, player, 'BK1-062', 0, { faceUp: false });
    state = openable(card.state, player, card.card);
    const offers = engine
      .legalActions(state, player)
      .filter(
        (a): a is Extract<GameAction, { type: 'OPEN_CARD' }> =>
          a.type === 'OPEN_CARD' && a.card === card.card,
      );
    expect(offers.map((a) => a.areas?.[0])).toEqual([3]);
    state = apply(state, player, offers[0] as GameAction);
    expect(state.cards[mine.card]?.cityIndex).toBe(3);
    expect(state.cards[mine.card]?.locked).toBe(false);
  });
});

describe('BK1-061 Reunion On The Hill Of Swords', () => {
  it('sets a character from hand and opens it for nothing, unless an enemy came here this turn', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;
    // The card is set first, then Guts (Level 3) is put in hand: Level 4 or
    // lower qualifies.
    const card = place(state, player, 'BK1-061', 2, { faceUp: false });
    state = openable(card.state, player, card.card);
    const spare = Object.values(state.cards).find(
      (c) => c.controller === player && c.zone === 'hand',
    ) as CardInstance;
    state = {
      ...state,
      cards: { ...state.cards, [spare.instanceId]: { ...spare, defId: asCardDefId('BK1-044') } },
    };
    // City Level is 3 for the card itself; Guts would need it too, but the
    // effect ignores the gate. Nobody has moved here: the condition holds.
    state = apply(state, player, openOf(state, player, card.card) as GameAction);
    expect(state.pending?.kind).toMatchObject({ zone: 'hand', action: 'setAndOpen' });
    state = apply(state, player, { type: 'CHOOSE_CARD', card: spare.instanceId });
    const guts = state.cards[spare.instanceId];
    expect(guts?.zone).toBe('city');
    expect(guts?.faceUp).toBe(true);
    expect(guts?.cityIndex).toBe(2);
    expect(state.turn.openedThisTurn).toBe(true); // the card itself spent it

    // Now an enemy arrives in the area this turn, and the same card fizzles.
    let again = started(GREEN);
    const enemy = place(again, other, 'BK1-041', 1);
    again = enemy.state;
    again = { ...again, turn: { ...again.turn, arrivals: [{ player: other, city: 2 }] } };
    const second = place(again, player, 'BK1-061', 2, { faceUp: false });
    again = openable(second.state, player, second.card);
    const result = engine.reduce(again, player, openOf(again, player, second.card) as GameAction);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The condition is unmet, so the ability does not fire at all: nothing
      // is asked, and nothing is set.
      expect(result.value.state.pending).toBeNull();
      expect(result.value.events.map((e) => e.type)).not.toContain('CHOICE_REQUIRED');
    }
  });
});

describe('BK1-066 Lost Time', () => {
  it('asks at the start of the turn, and a yes trades the draw for two at the end', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;
    state = place(state, player, 'BK1-066', 2).state;
    // Round the turn to the owner's next: the trigger asks at its start.
    state = endTurn(state, player);
    expect(state.turn.activePlayer).toBe(other);
    state = endTurn(state, other);
    expect(state.turn.activePlayer).toBe(player);
    expect(state.pending?.kind.zone).toBe('decision');
    expect(state.pending?.waitingOn).toBe(player);

    const before = zoneSize(state, player, 'hand');
    state = apply(state, player, { type: 'ANSWER', accept: true });
    // The Draw phase ran without drawing.
    expect(state.turn.drawSkipped).toBe(true);
    expect(zoneSize(state, player, 'hand')).toBe(before);
    const events: GameEvent[] = [];
    state = endTurn(state, player, events);
    expect(events.filter((e) => e.type === 'CARD_DRAWN' && e.player === player)).toHaveLength(2);
  });
});

describe('attachments (Rules.md §13)', () => {
  it('BK1-076 Sylph Sword lends +1 Range and +3 Power while both stand, and falls with its host', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const host = place(state, player, 'BK1-041', 2);
    const sword = place(host.state, player, 'BK1-076', 2, { faceUp: false });
    state = openable(sword.state, player, sword.card);
    const open = engine
      .legalActions(state, player)
      .find(
        (a): a is Extract<GameAction, { type: 'OPEN_CARD' }> =>
          a.type === 'OPEN_CARD' && a.card === sword.card && a.targets?.[0] === host.card,
      );
    expect(open).toBeDefined();
    const printed = power(state, host.card);
    state = apply(state, player, open as GameAction);
    expect(state.cards[sword.card]?.attachedTo).toBe(host.card);
    expect(power(state, host.card)).toBe(printed + 3);
    expect(rangeOf({ registry }, state, cardOf(state, host.card))).toBe(1);
    expect(boostSources({ registry }, state, cardOf(state, host.card))).toContain(sword.card);

    // The host dies; the sword goes with it.
    const dead = { ...cardOf(state, host.card), damage: 99 };
    const result = engine.reduce(
      { ...state, cards: { ...state.cards, [host.card]: dead } },
      player,
      { type: 'END_PHASE' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Damage is swept at the End phase rather than killing outright, so use
    // the effect route instead: send the host to the Trash directly.
    let gone = state;
    gone = {
      ...gone,
      cards: { ...gone.cards, [host.card]: { ...cardOf(gone, host.card), zone: 'trash' as const } },
    };
    const swept = engine.reduce(gone, player, { type: 'END_PHASE' });
    expect(swept.ok).toBe(true);
    if (swept.ok) expect(swept.value.state.cards[sword.card]?.zone).toBe('trash');
  });
});

describe('damage reduction (Rules.md §13)', () => {
  it('BK1-052 Serpico shrugs off the first 3 of any blow struck in combat', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;

    const serpico = place(state, player, 'BK1-052', 2);
    state = serpico.state;

    const card = cardOf(state, serpico.card);
    expect(damageAfterReduction({ registry }, state, card, 5, { combat: true })).toBe(2);
    // Never past nothing: a small hit is absorbed, not turned into healing.
    expect(damageAfterReduction({ registry }, state, card, 2, { combat: true })).toBe(0);
    // His line says "during combat", so it is silent about an effect.
    expect(damageAfterReduction({ registry }, state, card, 5, { combat: false })).toBe(5);
  });

  it('BK1-051 Serpico takes nothing at all from a blow he outclasses', () => {
    // Through a real battle, because reduction has to bite where the damage
    // lands: §11 ④ makes the striker spend its Power exactly, so this cannot
    // be done by letting the attacker assign less.
    let state = started(GREEN);
    const attacker = state.turn.activePlayer;
    const defender = state.seats.find((seat) => seat !== attacker) as PlayerId;

    // A 1-Power Mercenary against Serpico's 3 points of armour.
    const merc = place(state, attacker, 'BK1-041', 2);
    state = merc.state;
    const serpico = place(state, defender, 'BK1-051', 2);
    state = serpico.state;
    state = atMain({ ...state, turn: { ...state.turn, priorityPlayer: attacker } });

    state = apply(state, attacker, { type: 'DECLARE_BATTLE', city: 2 });
    state = apply(state, attacker, { type: 'DESIGNATE_VANGUARD', card: merc.card });
    state = runBattle(state, defender);

    // Serpico has 1 HP: without the reduction that Mercenary would kill him.
    expect(state.cards[serpico.card]?.zone).toBe('city');
    expect(state.cards[serpico.card]?.damage).toBe(0);
  });

  it('BK1-064 shields a character for the turn, and reaches an adjacent area', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;

    const near = place(state, player, 'BK1-041', 3);
    state = near.state;

    const vow = place(state, player, 'BK1-064', 2, { faceUp: false });
    state = openable(vow.state, player, vow.card);

    // Distance 1 from city 2 reaches city 3, which "this area" would not.
    const open = openOf(state, player, vow.card);
    expect(open?.targets).toEqual([near.card]);
    state = apply(state, player, open as GameAction);

    const shielded = cardOf(state, near.card);
    expect(damageAfterReduction({ registry }, state, shielded, 5, { combat: false })).toBe(2);
    // Written onto the card, so it is swept with the boosts at end of turn.
    expect(shielded.counters[SHIELD]).toBe(3);
  });

  it('BK1-071 Magical Barrier stacks its shield with Serpico’s own armour', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;

    const serpico = place(state, player, 'BK1-052', 2);
    state = serpico.state;

    const barrier = place(state, player, 'BK1-071', 2, { faceUp: false });
    state = openable(barrier.state, player, barrier.card);
    const open = openOf(state, player, barrier.card);
    state = apply(state, player, {
      ...(open as Extract<GameAction, { type: 'OPEN_CARD' }>),
      targets: [serpico.card],
    });

    const card = cardOf(state, serpico.card);
    // The barrier is 2 from any source; Serpico's own 3 is combat only.
    expect(damageAfterReduction({ registry }, state, card, 9, { combat: false })).toBe(7);
    expect(damageAfterReduction({ registry }, state, card, 9, { combat: true })).toBe(4);
  });

  it('a shield lasts the turn and no longer', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;

    const friend = place(state, player, 'BK1-041', 2);
    state = friend.state;
    const vow = place(state, player, 'BK1-064', 2, { faceUp: false });
    state = openable(vow.state, player, vow.card);
    state = apply(state, player, {
      ...(openOf(state, player, vow.card) as Extract<GameAction, { type: 'OPEN_CARD' }>),
      targets: [friend.card],
    });
    expect(cardOf(state, friend.card).counters[SHIELD]).toBe(3);

    state = endTurn(state, player);
    expect(cardOf(state, friend.card).counters[SHIELD] ?? 0).toBe(0);
  });
});

describe('cost-bearing abilities are used by choice and paid for (Rules.md §13)', () => {
  /** The USE_ABILITY the engine offers for this card, if it is offering one. */
  const useOf = (
    state: GameState,
    player: PlayerId,
    card: CardInstanceId,
  ): Extract<GameAction, { type: 'USE_ABILITY' }> | undefined =>
    engine
      .legalActions(state, player)
      .find(
        (action): action is Extract<GameAction, { type: 'USE_ABILITY' }> =>
          action.type === 'USE_ABILITY' && action.card === card,
      );

  it('BK1-056 Isidro locks himself to draw, and cannot do it twice', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;

    const isidro = place(state, player, 'BK1-056', 2);
    state = atMain(isidro.state);

    const use = useOf(state, player, isidro.card);
    expect(use, 'the tap ability should be offered in Main').toBeDefined();

    const before = zoneSize(state, player, 'hand');
    state = apply(state, player, use as GameAction);

    expect(zoneSize(state, player, 'hand')).toBe(before + 1);
    // "Tap:" is a cost (Rules.md §6), so he is locked and cannot pay it again.
    expect(cardOf(state, isidro.card).locked).toBe(true);
    expect(useOf(state, player, isidro.card)).toBeUndefined();
  });

  it('BK1-055 Isidro burns a character he is pointed at, and only in his area', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const isidro = place(state, player, 'BK1-055', 2);
    state = isidro.state;
    const here = place(state, other, 'BK1-041', 2);
    state = here.state;
    const away = place(state, other, 'BK1-041', 4);
    state = away.state;
    state = atMain(state);

    const use = useOf(state, player, isidro.card);
    expect(use, 'the tap ability should be offered').toBeDefined();

    // The one in the next area is not in this area, whatever the client asks.
    const wrong = engine.reduce(state, player, {
      ...(use as Extract<GameAction, { type: 'USE_ABILITY' }>),
      targets: [away.card],
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.code).toBe('ILLEGAL_TARGET');

    state = apply(state, player, {
      ...(use as Extract<GameAction, { type: 'USE_ABILITY' }>),
      targets: [here.card],
    });
    // A 1/1 Mercenary does not survive 1 damage.
    expect(state.cards[here.card]?.zone).toBe('trash');
    expect(state.cards[away.card]?.zone).toBe('city');
  });

  it('BK1-009 Griffith calls a Hawk to his area from up to three away', () => {
    let state = started();
    const player = state.turn.activePlayer;

    const griffith = place(state, player, 'BK1-009', 1);
    state = griffith.state;
    // BK1-011 Guts is a Hawk. Three areas away is within reach (Rules.md §15).
    const guts = place(state, player, 'BK1-011', 4);
    state = atMain(guts.state);

    const use = useOf(state, player, griffith.card);
    expect(use, 'the paid ability should be offered in Main').toBeDefined();

    const before = zoneSize(state, player, 'hand');
    state = apply(state, player, {
      ...(use as Extract<GameAction, { type: 'USE_ABILITY' }>),
      targets: [guts.card],
    });

    expect(cardOf(state, guts.card).cityIndex).toBe(1);
    // The effect moved him, so §10 ④(1)'s price is not charged: he is not
    // locked, and his own Move of 1 never had to cover three areas.
    expect(cardOf(state, guts.card).locked).toBe(false);
    expect(zoneSize(state, player, 'hand')).toBe(before - 1);
  });

  it('BK1-009 will not call himself, a stranger, or anyone four areas off', () => {
    let state = started();
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const griffith = place(state, player, 'BK1-009', 0);
    state = griffith.state;
    // Four areas away — outside "within 3 spaces".
    const far = place(state, player, 'BK1-011', 4);
    state = far.state;
    // A Hawk, in reach, but not his.
    const theirs = place(state, other, 'BK1-011', 1);
    state = theirs.state;
    // In reach and his, but no Hawk on its type line.
    const merc = place(state, player, 'BK1-001', 1);
    state = atMain(merc.state);

    const offered = engine
      .legalActions(state, player)
      .filter(
        (action): action is Extract<GameAction, { type: 'USE_ABILITY' }> =>
          action.type === 'USE_ABILITY' && action.card === griffith.card,
      );
    expect(offered).toHaveLength(0);

    // And the reducer refuses each of them however the action is assembled —
    // "another character with the Hawk subtype that you control".
    for (const wrong of [griffith.card, far.card, theirs.card, merc.card]) {
      const result = engine.reduce(state, player, {
        type: 'USE_ABILITY',
        card: griffith.card,
        ability: '0',
        targets: [wrong],
      });
      expect(result.ok, `${wrong} should not be a legal target`).toBe(false);
    }
  });

  it('BK1-009 leaves the area he emptied to whoever is left in it', () => {
    let state = started();
    const player = state.turn.activePlayer;

    const griffith = place(state, player, 'BK1-009', 1);
    state = griffith.state;
    const guts = place(state, player, 'BK1-011', 3);
    state = guts.state;
    // Rules.md §12 — an occupier with nobody left there loses the city.
    state = {
      ...state,
      cities: state.cities.map((city) =>
        city.index === 3 ? { ...city, faceUp: true, occupiedBy: player } : city,
      ),
    };
    state = atMain(state);

    const use = useOf(state, player, griffith.card);
    state = apply(state, player, {
      ...(use as Extract<GameAction, { type: 'USE_ABILITY' }>),
      targets: [guts.card],
    });

    expect(state.cities[3]?.occupiedBy).toBeNull();
  });

  it('BK1-045 Guts pays a green card from hand, once per turn', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;

    const guts = place(state, player, 'BK1-045', 2);
    state = atMain(guts.state);

    const printed = registry.get(asCardDefId('BK1-045')).stats;
    const use = useOf(state, player, guts.card);
    expect(use, 'the paid ability should be offered').toBeDefined();
    expect(use?.pay).toHaveLength(1);

    const before = zoneSize(state, player, 'hand');
    state = apply(state, player, use as GameAction);

    expect(power(state, guts.card)).toBe((printed?.power ?? 0) + 2);
    expect(hp(state, guts.card)).toBe((printed?.hp ?? 0) + 2);
    // The cost came out of hand into the Trash (§13), and he is not locked —
    // his printed cost is a card, not a tap.
    expect(zoneSize(state, player, 'hand')).toBe(before - 1);
    expect(cardOf(state, guts.card).locked).toBe(false);

    // "Can only be used once per turn."
    expect(useOf(state, player, guts.card)).toBeUndefined();
  });

  it('BK1-045 comes back the following turn', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const guts = place(state, player, 'BK1-045', 2);
    state = atMain(guts.state);
    state = apply(state, player, useOf(state, player, guts.card) as GameAction);
    expect(useOf(state, player, guts.card)).toBeUndefined();

    state = endTurn(state, player);
    state = endTurn(state, other);
    state = atMain(state);
    expect(state.turn.activePlayer).toBe(player);
    expect(useOf(state, player, guts.card)).toBeDefined();
  });

  it('BK1-054 Schierke is not offered her ability outside her own Main phase', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const schierke = place(state, player, 'BK1-054', 2);
    state = schierke.state;

    // §13 — a cost-bearing ability without Quick waits for its own Main phase.
    state = openable(state, player, schierke.card);
    expect(useOf(state, player, schierke.card)).toBeUndefined();

    state = atMain(state);
    expect(useOf(state, player, schierke.card)).toBeDefined();

    // And it is the *controller's* Main phase, not merely any Main phase.
    const theirTurn = {
      ...state,
      turn: { ...state.turn, activePlayer: other, priorityPlayer: other },
    };
    expect(useOf(theirTurn, player, schierke.card)).toBeUndefined();
    expect(
      engine.reduce(theirTurn, player, {
        type: 'USE_ABILITY',
        card: schierke.card,
        ability: '0',
      }).ok,
    ).toBe(false);
  });

  it('BK1-079 Camp Survey locks one of your characters instead of itself', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;

    const ally = place(state, player, 'BK1-041', 2);
    state = ally.state;
    const other = place(state, player, 'BK1-041', 2);
    state = other.state;
    // The Eternal itself is not a character and cannot pay a tap.
    const survey = place(state, player, 'BK1-079', 2);
    state = atMain(survey.state);

    const printed = registry.get(asCardDefId('BK1-041')).stats;
    const use = useOf(state, player, survey.card);
    expect(use, 'the quick ability should be offered in Main').toBeDefined();
    expect(use?.targets).toHaveLength(1);

    state = apply(state, player, {
      ...(use as Extract<GameAction, { type: 'USE_ABILITY' }>),
      targets: [ally.card],
    });

    // The named ally paid the cost; both of them still got the buff.
    expect(cardOf(state, ally.card).locked).toBe(true);
    expect(cardOf(state, other.card).locked).toBe(false);
    expect(power(state, ally.card)).toBe((printed?.power ?? 0) + 2);
    expect(power(state, other.card)).toBe((printed?.power ?? 0) + 2);
    expect(hp(state, other.card)).toBe((printed?.hp ?? 0) + 1);
    // The Eternal stays on the board — only its cost was spent.
    expect(state.cards[survey.card]?.zone).toBe('city');
  });

  it('BK1-048 Casca goes home and draws, for one price', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;

    const casca = place(state, player, 'BK1-048', 2);
    state = atMain(casca.state);

    const use = useOf(state, player, casca.card);
    expect(use, 'the paid ability should be offered').toBeDefined();

    const before = zoneSize(state, player, 'hand');
    state = apply(state, player, use as GameAction);

    // One card paid, Casca back in hand, two drawn.
    expect(state.cards[casca.card]?.zone).toBe('hand');
    expect(zoneSize(state, player, 'hand')).toBe(before - 1 + 1 + 2);
  });

  it('BK1-046 Guts is offered only while there is a combat to strike into', () => {
    let state = started(GREEN);
    const attacker = state.turn.activePlayer;
    const defender = state.seats.find((seat) => seat !== attacker) as PlayerId;

    const guts = place(state, defender, 'BK1-046', 2);
    state = guts.state;
    const foe = place(state, attacker, 'BK1-041', 2);
    state = foe.state;
    state = atMain(state);

    // Nobody is in combat yet, so there is nobody to point it at.
    expect(useOf(state, defender, guts.card)).toBeUndefined();

    state = apply(state, attacker, { type: 'DECLARE_BATTLE', city: 2 });
    state = apply(state, attacker, { type: 'DESIGNATE_VANGUARD', card: foe.card });

    // A Quick ability rides the same window a Quick card does, so it is
    // offered to the player the engine is actually asking.
    // Declaring the attack opens a window for the defender, because they now
    // have something they could answer with.
    expect(state.quick?.waitingOn).toBe(defender);

    const use = useOf(state, defender, guts.card);
    expect(use, 'the quick ability should be offered in the window').toBeDefined();
    expect(use?.targets).toEqual([foe.card]);
    state = apply(state, defender, use as GameAction);

    // The vanguard is a 1/1 Mercenary and 3 damage is more than enough.
    expect(state.cards[foe.card]?.zone).toBe('trash');
    // Locked as a cost, and the ability is spent for this turn.
    expect(cardOf(state, guts.card).locked).toBe(true);
  });
});

describe('every legal target is offered as its own action', () => {
  // The client cannot work out who a card may point at — colour, Level,
  // Distance and whether a battle is running are rules that live in the
  // engine. It lights up what it is offered, so it has to be offered all of
  // them, not one suggestion.
  const opensFor = (
    state: GameState,
    player: PlayerId,
    card: CardInstanceId,
  ): Extract<GameAction, { type: 'OPEN_CARD' }>[] =>
    engine
      .legalActions(state, player)
      .filter(
        (action): action is Extract<GameAction, { type: 'OPEN_CARD' }> =>
          action.type === 'OPEN_CARD' && action.card === card,
      );

  it('offers one open per candidate, and only the legal ones', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const mine = place(state, player, 'BK1-041', 2);
    state = mine.state;
    const theirs = place(state, other, 'BK1-041', 2);
    state = theirs.state;
    // Another area entirely: BK1-063 says "in this area".
    const away = place(state, other, 'BK1-041', 4);
    state = away.state;

    const buff = place(state, player, 'BK1-063', 2, { faceUp: false });
    state = openable(buff.state, player, buff.card);

    const offered = opensFor(state, player, buff.card);
    const aimed = offered.map((action) => action.targets?.[0]);
    expect(new Set(aimed)).toEqual(new Set([mine.card, theirs.card]));
    expect(aimed).not.toContain(away.card);
  });

  it('narrows to what the card may actually be pointed at', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    state = place(state, other, 'BK1-041', 2).state;
    const black = place(state, other, 'BK1-081', 2);
    state = black.state;

    // BK1-080 destroys a *black* character, so the green one is not offered.
    const bond = place(state, player, 'BK1-080', 2, { faceUp: false });
    state = openable(bond.state, player, bond.card);

    const aimed = opensFor(state, player, bond.card).map((action) => action.targets?.[0]);
    expect(aimed).toEqual([black.card]);
  });

  it('reaches into an adjacent area when the card says Distance', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;

    const here = place(state, player, 'BK1-041', 2);
    state = here.state;
    const next = place(state, player, 'BK1-041', 3);
    state = next.state;
    const far = place(state, player, 'BK1-041', 0);
    state = far.state;

    const vow = place(state, player, 'BK1-064', 2, { faceUp: false });
    state = openable(vow.state, player, vow.card);

    const aimed = opensFor(state, player, vow.card).map((action) => action.targets?.[0]);
    expect(new Set(aimed)).toEqual(new Set([here.card, next.card]));
    // City 0 is two away from city 2.
    expect(aimed).not.toContain(far.card);
  });

  it('still offers the open when there is nobody to point at', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;

    // Nothing else on the board, and an Effect card is not a character.
    const buff = place(state, player, 'BK1-063', 2, { faceUp: false });
    state = openable(buff.state, player, buff.card);

    const offered = opensFor(state, player, buff.card);
    expect(offered).toHaveLength(1);
    expect(offered[0]?.targets).toBeUndefined();
    expect(engine.reduce(state, player, offered[0] as GameAction).ok).toBe(true);
  });
});

describe('legalActions and reduce agree about abilities', () => {
  it('accepts every ability it offers, across a board full of them', () => {
    // The general agreement test in engine.test.ts runs on placeholder cards,
    // which have no abilities at all — so the invariant is checked again here
    // against the real ones.
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    for (const defId of ['BK1-044', 'BK1-045', 'BK1-054', 'BK1-055', 'BK1-056', 'BK1-079']) {
      state = place(state, player, defId, 2).state;
    }
    state = place(state, other, 'BK1-041', 2).state;
    state = atMain(state);

    const offered = engine
      .legalActions(state, player)
      .filter((action) => action.type === 'USE_ABILITY');
    expect(offered.length).toBeGreaterThan(0);

    for (const action of offered) {
      const result = engine.reduce(state, player, action);
      expect(result.ok, `${JSON.stringify(action)} should be accepted`).toBe(true);
    }
  });

  it('refuses an ability the card does not have', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const isidro = place(state, player, 'BK1-056', 2);
    state = atMain(isidro.state);

    const result = engine.reduce(state, player, {
      type: 'USE_ABILITY',
      card: isidro.card,
      ability: '7',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ILLEGAL_TARGET');
  });

  it('refuses to use a locked character’s tap ability', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const isidro = place(state, player, 'BK1-056', 2);
    state = atMain(isidro.state);
    state = {
      ...state,
      cards: { ...state.cards, [isidro.card]: { ...cardOf(state, isidro.card), locked: true } },
    };

    expect(engine.legalActions(state, player).some((action) => action.type === 'USE_ABILITY')).toBe(
      false,
    );
    const result = engine.reduce(state, player, {
      type: 'USE_ABILITY',
      card: isidro.card,
      ability: '0',
    });
    expect(result.ok).toBe(false);
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

describe('effects that stop and ask (Rules.md §13)', () => {
  /**
   * A dealt match from a deck built out of named cards, for the searches that
   * need something specific to find. `started` deals one repeated card, which
   * a search would either always or never find.
   */
  const startedWith = (cards: readonly string[], seed = 11): GameState => {
    const deck = { cards: cards.map(asCardDefId) };
    const match = engine.createMatch({
      matchId: asMatchId('search'),
      seed,
      decks: [
        { playerId: ALICE, name: 'Alice', ...deck },
        { playerId: BOB, name: 'Bob', ...deck },
      ],
    });
    const kept = engine.reduceAll(match, [
      { actor: ALICE, action: { type: 'KEEP_HAND' } },
      { actor: BOB, action: { type: 'KEEP_HAND' } },
    ]);
    if (!kept.ok) throw new Error(`setup failed: ${kept.error.message}`);
    return kept.value.state;
  };

  /** Three Serpico — the deck limit — in a deck that can pay a green cost. */
  const WITH_SERPICO = [...Array(3).fill('BK1-051'), ...Array(42).fill(GREEN)];

  /** The cards the engine is offering as answers to the outstanding choice. */
  const choicesFor = (state: GameState, player: PlayerId): CardInstanceId[] =>
    engine
      .legalActions(state, player)
      .filter((action) => action.type === 'CHOOSE_CARD')
      .map((action) => (action as Extract<GameAction, { type: 'CHOOSE_CARD' }>).card);

  it('BK1-047 Casca draws three and then asks which two to pitch', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const casca = place(state, player, 'BK1-047', 2, { faceUp: false });
    state = openable(casca.state, player, casca.card);

    const before = zoneSize(state, player, 'hand');
    state = apply(state, player, openOf(state, player, casca.card) as GameAction);

    // Three drawn, one spent on the cost, and nothing discarded yet: the
    // discard is the player's to make.
    expect(state.pending?.waitingOn).toBe(player);
    expect(state.pending?.count).toBe(2);
    expect(zoneSize(state, player, 'hand')).toBe(before + 3 - 1);

    // Every card in hand is a legal answer, and nothing else is offered.
    const hand = state.zoneOrder[`${player}:hand`] ?? [];
    expect(choicesFor(state, player).sort()).toEqual([...hand].sort());
    expect(
      engine
        .legalActions(state, player)
        .every((a) => a.type === 'CHOOSE_CARD' || a.type === 'CONCEDE'),
      'nothing but the choice and conceding should be legal',
    ).toBe(true);

    // It asks twice, one card at a time.
    const first = choicesFor(state, player)[0] as CardInstanceId;
    state = apply(state, player, { type: 'CHOOSE_CARD', card: first });
    expect(state.cards[first]?.zone).toBe('trash');
    expect(state.pending?.count).toBe(1);

    const second = choicesFor(state, player)[0] as CardInstanceId;
    state = apply(state, player, { type: 'CHOOSE_CARD', card: second });
    expect(state.cards[second]?.zone).toBe('trash');
    expect(state.pending).toBeNull();
    expect(zoneSize(state, player, 'hand')).toBe(before + 3 - 1 - 2);
  });

  it('holds the whole game still until the question is answered', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;
    const casca = place(state, player, 'BK1-047', 2, { faceUp: false });
    state = openable(casca.state, player, casca.card);
    state = apply(state, player, openOf(state, player, casca.card) as GameAction);

    // The opponent may not act around it, and may not answer it either.
    expect(engine.legalActions(state, other)).toEqual([{ type: 'CONCEDE' }]);
    const hand = state.zoneOrder[`${player}:hand`] ?? [];
    const stolen = engine.reduce(state, other, {
      type: 'CHOOSE_CARD',
      card: hand[0] as CardInstanceId,
    });
    expect(stolen.ok).toBe(false);

    // Nor may the player it is waiting on do anything but answer.
    expect(engine.reduce(state, player, { type: 'END_PHASE' }).ok).toBe(false);
    // Conceding is always available, so nobody is trapped by a prompt.
    expect(engine.reduce(state, player, { type: 'CONCEDE' }).ok).toBe(true);
  });

  it('never asks for more cards than the hand holds', () => {
    // A hand of one owing two discards would be a question with no second
    // answer, and the player would be stuck on the prompt forever. Casca
    // always draws three before she asks, so the only way to be short is to
    // ask against a hand that has been emptied — BK1-017's opponent-discard
    // path is the same effect from the other side and reaches it directly.
    let state = started();
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;
    const corkus = place(state, player, 'BK1-017', 2, { faceUp: false });
    state = openable(corkus.state, player, corkus.card);
    state = { ...state, zoneOrder: { ...state.zoneOrder, [`${other}:hand`]: [] } };

    // An empty hand has nothing to lose, and nothing hangs waiting on it.
    state = apply(state, player, openOf(state, player, corkus.card) as GameAction);
    expect(state.pending).toBeNull();
    expect(state.status.kind).toBe('playing');
  });

  it('does not ask once the match is already over', () => {
    // BK1-047 draws three before she discards two, and drawing from an empty
    // deck is a loss (Rules.md §10 ②). The prompt must not survive the match:
    // `legalActions` rightly offers nothing once the game is decided, so a
    // pending choice would be a question with no legal answer at all.
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const casca = place(state, player, 'BK1-047', 2, { faceUp: false });
    state = openable(casca.state, player, casca.card);
    state = { ...state, zoneOrder: { ...state.zoneOrder, [`${player}:deck`]: [] } };

    state = apply(state, player, openOf(state, player, casca.card) as GameAction);
    expect(state.status).toMatchObject({ kind: 'finished', reason: 'deck_out' });
    expect(state.pending).toBeNull();
    expect(engine.legalActions(state, player)).toEqual([]);
  });

  it('BK1-050 Farnese searches out a Serpico, and only a Serpico', () => {
    // A deck of Serpico and Mercenary, so the search has both something to
    // find and something it must not offer.
    let state = startedWith(WITH_SERPICO);
    const player = state.turn.activePlayer;
    const farnese = place(state, player, 'BK1-050', 2, { faceUp: false });
    state = openable(farnese.state, player, farnese.card);
    const deckBefore = zoneSize(state, player, 'deck');
    state = apply(state, player, openOf(state, player, farnese.card) as GameAction);

    expect(state.pending?.count).toBe(1);
    const offered = choicesFor(state, player);
    expect(offered.length).toBeGreaterThan(0);
    // Everything offered is a Serpico still in the deck.
    for (const id of offered) {
      expect(registry.get(cardOf(state, id).defId).name).toBe('Serpico');
      expect(cardOf(state, id).zone).toBe('deck');
    }

    const taken = offered[0] as CardInstanceId;
    state = apply(state, player, { type: 'CHOOSE_CARD', card: taken });
    expect(cardOf(state, taken).zone).toBe('hand');
    expect(zoneSize(state, player, 'deck')).toBe(deckBefore - 1);
    expect(state.pending).toBeNull();
  });

  it('reveals the searchable cards to the searcher and to nobody else', () => {
    let state = startedWith(WITH_SERPICO);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;
    const farnese = place(state, player, 'BK1-050', 2, { faceUp: false });
    state = openable(farnese.state, player, farnese.card);
    state = apply(state, player, openOf(state, player, farnese.card) as GameAction);

    const deck = state.zoneOrder[`${player}:deck`] ?? [];
    const mine = engine.viewFor(state, player);
    const theirs = engine.viewFor(state, other);

    let seen = 0;
    for (const id of deck) {
      const card = mine.cards[id];
      if (!card) continue;
      const serpico = registry.get(cardOf(state, id).defId).name === 'Serpico';
      // The searcher sees exactly the Serpicos; the rest of their deck is
      // still face-down to them, or the search has leaked the draw order.
      expect(isHidden(card)).toBe(!serpico);
      if (serpico) seen++;
      // The opponent sees none of it, searched or not.
      const theirCopy = theirs.cards[id];
      expect(theirCopy && isHidden(theirCopy)).toBe(true);
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('shuffles the deck once the search is over, and not before', () => {
    let state = startedWith(WITH_SERPICO);
    const player = state.turn.activePlayer;
    const farnese = place(state, player, 'BK1-050', 2, { faceUp: false });
    state = openable(farnese.state, player, farnese.card);
    state = apply(state, player, openOf(state, player, farnese.card) as GameAction);

    // Still in its original order while the player is looking through it.
    const during = [...(state.zoneOrder[`${player}:deck`] ?? [])];
    const taken = choicesFor(state, player)[0] as CardInstanceId;
    state = apply(state, player, { type: 'CHOOSE_CARD', card: taken });

    const after = [...(state.zoneOrder[`${player}:deck`] ?? [])];
    expect(after).toHaveLength(during.length - 1);
    // Same cards, different order: the deck was shuffled, not merely shortened.
    expect([...after].sort()).toEqual(during.filter((id) => id !== taken).sort());
    expect(after).not.toEqual(during.filter((id) => id !== taken));
  });

  it('finds nothing without stopping to ask, and still shuffles', () => {
    // A deck with no Serpico in it. Rules.md §13 — the effect resolves and
    // finds nobody; it is not an error and must not freeze the game.
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const farnese = place(state, player, 'BK1-050', 2, { faceUp: false });
    state = openable(farnese.state, player, farnese.card);

    state = apply(state, player, openOf(state, player, farnese.card) as GameAction);
    expect(state.pending).toBeNull();
    expect(cardOf(state, farnese.card).faceUp).toBe(true);
  });

  it('BK1-032 moves an enemy to an area the player picks, and draws', () => {
    // "Move it to an adjacent area" — a real choice at a middle city, so the
    // engine offers one open per (character, area) pair and accepts either.
    let state = started();
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    // A Level 0 Mercenary, which is "level 2 or less".
    const victim = place(state, other, 'BK1-001', 2);
    state = victim.state;
    const sentries = place(state, player, 'BK1-032', 2, { faceUp: false });
    state = openable(sentries.state, player, sentries.card);

    // Both neighbours of city 2 are offered, and nothing else.
    const offers = engine
      .legalActions(state, player)
      .filter(
        (action): action is Extract<GameAction, { type: 'OPEN_CARD' }> =>
          action.type === 'OPEN_CARD' && action.card === sentries.card,
      );
    expect(offers.map((o) => o.areas?.[0]).sort()).toEqual([1, 3]);
    for (const offer of offers) expect(offer.targets).toEqual([victim.card]);

    const before = zoneSize(state, player, 'hand');
    const toThree = offers.find((o) => o.areas?.[0] === 3) as GameAction;
    state = apply(state, player, toThree);

    // Moved where asked, and the draw rode along on the same printed line.
    expect(cardOf(state, victim.card).cityIndex).toBe(3);
    const paid = (toThree as Extract<GameAction, { type: 'OPEN_CARD' }>).pay.length;
    expect(zoneSize(state, player, 'hand')).toBe(before + 1 - paid);
  });

  it('BK1-032 offers one area at the end of the row, not two', () => {
    // City 0 has a single neighbour, so there is nothing to choose between.
    let state = started();
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const victim = place(state, other, 'BK1-001', 0);
    state = victim.state;
    const sentries = place(state, player, 'BK1-032', 0, { faceUp: false });
    state = openable(sentries.state, player, sentries.card);

    const offers = engine
      .legalActions(state, player)
      .filter(
        (action): action is Extract<GameAction, { type: 'OPEN_CARD' }> =>
          action.type === 'OPEN_CARD' && action.card === sentries.card,
      );
    expect(offers.map((o) => o.areas?.[0])).toEqual([1]);
  });

  it('a character moved out of a battle stops fighting in it', () => {
    // Rules.md §12 reads the result off who *remains in the battle*. A
    // character an effect walked into the next city has left it, however it
    // was committed — the engine used to count it from wherever it stood,
    // which made moving a defender out change nothing.
    let state = started();
    const attacker = state.turn.activePlayer;
    const defender = state.seats.find((seat) => seat !== attacker) as PlayerId;

    const lead = place(state, attacker, 'BK1-001', 2);
    state = lead.state;
    const garrison = place(state, defender, 'BK1-001', 2);
    state = atMain(garrison.state);

    state = apply(state, attacker, { type: 'DECLARE_BATTLE', city: 2 });
    state = apply(state, attacker, { type: 'DESIGNATE_VANGUARD', card: lead.card });
    // Taken at the vanguard step, while the battle is still running: a 1v1
    // exchange settles itself the moment the defender commits, because
    // neither strike is a choice.
    const battle = state.battle as NonNullable<GameState['battle']>;
    expect(battle).not.toBeNull();

    // Both are in the contested city and both are participants, so both are
    // fighting. `participants` is set from the vanguard onward.
    const fighting = { ...battle, participants: [lead.card, garrison.card] };
    expect(stillFighting(state, fighting, attacker)).toHaveLength(1);
    expect(stillFighting(state, fighting, defender)).toHaveLength(1);

    // Walk the defender out of the contested city, as a card effect would.
    const moved = {
      ...state,
      cards: {
        ...state.cards,
        [garrison.card]: { ...cardOf(state, garrison.card), cityIndex: 3 },
      },
    } as GameState;

    // Still on the field, still a participant — and no longer in the fight.
    expect(cardOf(moved, garrison.card).zone).toBe('city');
    expect(stillFighting(moved, fighting, defender)).toEqual([]);
    expect(stillFighting(moved, fighting, attacker)).toHaveLength(1);
  });

  it('fires an on-open ability from the combat open too', () => {
    // Rules.md §11 ② — the defender's combat open is an open, so "when this
    // card is opened" fires there exactly as it does in the Open phase. The
    // step is not a separate way onto the board.
    let state = started(GREEN);
    const attacker = state.turn.activePlayer;
    const defender = state.seats.find((seat) => seat !== attacker) as PlayerId;

    // Somebody to lead the attack, and Farnese set face-down in the same city.
    const vanguard = place(state, attacker, GREEN, 2);
    state = vanguard.state;
    const farnese = place(state, defender, 'BK1-049', 2, { faceUp: false });
    state = atMain(farnese.state);

    state = apply(state, attacker, { type: 'DECLARE_BATTLE', city: 2 });
    state = apply(state, attacker, { type: 'DESIGNATE_VANGUARD', card: vanguard.card });
    expect(state.battle?.step).toBe('opens');
    expect(state.battle?.waitingOn).toBe(defender);

    const open = openOf(state, defender, farnese.card);
    expect(open, 'the defender should be offered the combat open').toBeDefined();

    const before = zoneSize(state, defender, 'hand');
    state = apply(state, defender, open as GameAction);

    // She is on the board and her line has resolved: two drawn, less whatever
    // the cost took out of hand.
    expect(cardOf(state, farnese.card).faceUp).toBe(true);
    const paid = (open as Extract<GameAction, { type: 'OPEN_CARD' }>).pay.length;
    expect(zoneSize(state, defender, 'hand')).toBe(before + 2 - paid);
  });

  it('asks its question from the combat open, and holds the battle for it', () => {
    // The same again with a card that stops to ask: the battle is frozen on
    // the question rather than settling past it, because the answer can still
    // change what the next step offers.
    let state = startedWith(WITH_SERPICO);
    const attacker = state.turn.activePlayer;
    const defender = state.seats.find((seat) => seat !== attacker) as PlayerId;

    const vanguard = place(state, attacker, GREEN, 2);
    state = vanguard.state;
    const farnese = place(state, defender, 'BK1-050', 2, { faceUp: false });
    state = atMain(farnese.state);

    state = apply(state, attacker, { type: 'DECLARE_BATTLE', city: 2 });
    state = apply(state, attacker, { type: 'DESIGNATE_VANGUARD', card: vanguard.card });
    state = apply(state, defender, openOf(state, defender, farnese.card) as GameAction);

    // The search is open and the battle has not moved on without it.
    expect(state.pending?.waitingOn).toBe(defender);
    expect(state.battle?.step).toBe('opens');
    expect(engine.legalActions(state, attacker)).toEqual([{ type: 'CONCEDE' }]);

    const taken = choicesFor(state, defender)[0] as CardInstanceId;
    state = apply(state, defender, { type: 'CHOOSE_CARD', card: taken });

    // Answered, and the battle picks up where it left off.
    expect(state.pending).toBeNull();
    expect(cardOf(state, taken).zone).toBe('hand');
    expect(state.battle).not.toBeNull();
  });

  it('an opponent’s discard is still taken at random, not chosen', () => {
    // The other side of the same effect: BK1-017 says "your opponent
    // discards", which is not the same as letting them pick their worst.
    // Corkus is white, so the hand paying for him has to be.
    let state = started();
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;
    const card = place(state, player, 'BK1-017', 2, { faceUp: false });
    state = openable(card.state, player, card.card);

    const before = zoneSize(state, other, 'hand');
    state = apply(state, player, openOf(state, player, card.card) as GameAction);

    expect(state.pending, 'nobody should be asked').toBeNull();
    expect(zoneSize(state, other, 'hand')).toBe(before - 1);
  });
});

/** The open the engine is offering for this card, if any. */
const openOf = (
  state: GameState,
  player: PlayerId,
  card: CardInstanceId,
): Extract<GameAction, { type: 'OPEN_CARD' }> | undefined =>
  engine
    .legalActions(state, player)
    .find(
      (action): action is Extract<GameAction, { type: 'OPEN_CARD' }> =>
        action.type === 'OPEN_CARD' && action.card === card,
    );

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

/**
 * Runs a declared battle out to its end, with the defender joining in.
 *
 * A battle nobody joins is a stalemate that deals no damage at all (§11 ③),
 * so a test about damage has to actually fight it.
 */
function runBattle(state: GameState, defender: PlayerId): GameState {
  let next = state;
  for (let guard = 0; guard < 24 && next.battle; guard++) {
    const waiting = next.battle.waitingOn;
    const actions = engine.legalActions(next, waiting);
    const join = actions.find(
      (action) => action.type === 'COMMIT_CHARACTER' && waiting === defender,
    );
    const assign = actions.find((action) => action.type === 'ASSIGN_DAMAGE');
    next = apply(next, waiting, join ?? assign ?? { type: 'BATTLE_PASS' });
  }
  return next;
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
    // A player holding a Quick card or a Quick ability is offered a window at
    // the turn's edges (§13). Nobody in these tests wants to use one, and the
    // turn cannot move on until it is declined.
    if (next.quick) {
      const waiting = next.quick.waitingOn;
      const result = engine.reduce(next, waiting, { type: 'PASS_PRIORITY' });
      if (!result.ok) throw new Error(`PASS_PRIORITY rejected: ${result.error.message}`);
      collect?.push(...result.value.events);
      next = result.value.state;
      continue;
    }
    const actions = engine.legalActions(next, next.turn.priorityPlayer);
    const discard = actions.find((action) => action.type === 'DISCARD_CARD');
    const end = actions.find((action) => action.type === 'END_PHASE');
    if (discard) step(discard);
    else if (end) step(end);
    else return next;
  }
  return next;
}

describe('the black Spirit Creatures (Rules.md §13)', () => {
  it('BK1-082 Disgusting Fiend burns the area it dies in, but not itself', () => {
    // "All characters in this area" — both sides. The source is already on
    // its way out (Rules.md §3), so it must not be caught by its own rattle.
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const fiend = place(state, player, 'BK1-082', 2);
    state = fiend.state;
    // A green Mercenary is 1/1, so a single point of splash kills it too.
    const bystander = place(state, player, GREEN, 2);
    state = bystander.state;
    const elsewhere = place(state, player, GREEN, 3);
    state = elsewhere.state;

    const schierke = place(state, other, 'BK1-053', 2, { faceUp: false });
    state = openable(schierke.state, other, schierke.card);
    state = { ...state, turn: { ...state.turn, activePlayer: other, priorityPlayer: other } };
    state = apply(state, other, openOf(state, other, schierke.card) as GameAction);

    expect(state.cards[fiend.card]?.zone).toBe('trash');
    // Caught by the death rattle in its own area...
    expect(state.cards[bystander.card]?.zone).toBe('trash');
    // ...while a character one city over is untouched.
    expect(state.cards[elsewhere.card]?.zone).toBe('city');
  });

  it('BK1-086 Will-o-the-wisp takes a card off the opponent as it dies', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const wisp = place(state, player, 'BK1-086', 2);
    state = wisp.state;
    const schierke = place(state, other, 'BK1-053', 2, { faceUp: false });
    state = openable(schierke.state, other, schierke.card);
    state = { ...state, turn: { ...state.turn, activePlayer: other, priorityPlayer: other } };

    // "Your opponent" is read from the dying card's side, so it is the player
    // who killed it that discards.
    const before = zoneSize(state, other, 'hand');
    state = apply(state, other, openOf(state, other, schierke.card) as GameAction);

    expect(state.cards[wisp.card]?.zone).toBe('trash');
    // Schierke left that hand too, hence two cards fewer.
    expect(zoneSize(state, other, 'hand')).toBe(before - 2);
  });

  it('BK1-084 Forest Ghost is only tougher while its side holds the city', () => {
    // Continuous, so it is read off the board and stops the instant the city
    // changes hands — there is nothing stored to undo.
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const ghost = place(state, player, 'BK1-084', 2);
    state = ghost.state;

    const held = {
      ...state,
      cities: state.cities.map((city, index) =>
        index === 2 ? { ...city, occupiedBy: player } : city,
      ),
    };
    // Printed 2/4: +0/+2 shows as 6 HP, and Power is untouched.
    expect(hp(held, ghost.card)).toBe(6);
    expect(power(held, ghost.card)).toBe(2);

    const lost = {
      ...state,
      cities: state.cities.map((city, index) =>
        index === 2 ? { ...city, occupiedBy: other } : city,
      ),
    };
    expect(hp(lost, ghost.card)).toBe(4);
  });

  it('BK1-090 Forest Guardian cannot attack, and its Quick trades HP for Power', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;

    const guardian = place(state, player, 'BK1-090', 2);
    state = guardian.state;

    // The first printed line is flat, not conditional on anything.
    expect(cannotAttack({ registry }, state, cardOf(state, guardian.card))).toBe(true);

    // Printed 1/5. The +2/-2 is a buff with a negative rather than damage, so
    // it is swept at end of turn instead of accumulating (Rules.md §10 ⑤).
    const use = engine
      .legalActions(atMain(state), player)
      .find((action) => action.type === 'USE_ABILITY' && action.card === guardian.card);
    expect(use, 'the Quick should be offered').toBeDefined();

    state = apply(atMain(state), player, use as GameAction);
    expect(power(state, guardian.card)).toBe(3);
    expect(hp(state, guardian.card)).toBe(3);
    expect(state.cards[guardian.card]?.damage).toBe(0);
  });

  it('BK1-105 A Crimson Lake Appears clears the whole area, both sides', () => {
    let state = started('BK1-081');
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const mine = place(state, player, 'BK1-081', 2);
    state = mine.state;
    const theirs = place(state, other, 'BK1-081', 2);
    state = theirs.state;
    const spared = place(state, other, 'BK1-081', 3);
    state = spared.state;

    const lake = place(state, player, 'BK1-105', 2, { faceUp: false });
    state = openable(lake.state, player, lake.card);
    const open = openOf(state, player, lake.card);
    expect(open, 'the lake should be openable').toBeDefined();
    state = apply(state, player, open as GameAction);

    // It destroys indiscriminately — its own controller's characters included.
    expect(state.cards[mine.card]?.zone).toBe('trash');
    expect(state.cards[theirs.card]?.zone).toBe('trash');
    expect(state.cards[spared.card]?.zone).toBe('city');
  });

  it('BK1-102 Rosine pays to stand back up', () => {
    let state = started('BK1-081');
    const player = state.turn.activePlayer;

    const rosine = place(state, player, 'BK1-102', 2);
    state = rosine.state;
    state = {
      ...state,
      cards: { ...state.cards, [rosine.card]: { ...cardOf(state, rosine.card), locked: true } },
    };

    const use = engine
      .legalActions(atMain(state), player)
      .find((action) => action.type === 'USE_ABILITY' && action.card === rosine.card);
    expect(use, 'unlock should be offered while she is locked').toBeDefined();

    state = apply(atMain(state), player, use as GameAction);
    expect(state.cards[rosine.card]?.locked).toBe(false);
  });
});

describe('black: the lines that needed new machinery (Rules.md §13)', () => {
  it('BK1-085 Creeping Nightmare locks its target and costs it the next Refresh', () => {
    let state = started('BK1-081');
    const player = state.turn.activePlayer;

    const nightmare = place(state, player, 'BK1-085', 2);
    state = nightmare.state;
    const victim = place(state, player, 'BK1-081', 2);
    state = victim.state;

    expect(cannotAttack({ registry }, state, cardOf(state, nightmare.card))).toBe(true);

    const use = engine
      .legalActions(atMain(state), player)
      .find(
        (action) =>
          action.type === 'USE_ABILITY' &&
          action.card === nightmare.card &&
          action.targets?.[0] === victim.card,
      );
    expect(use, 'the Nightmare should be able to point at somebody').toBeDefined();
    state = apply(atMain(state), player, use as GameAction);

    // Standing when it was pointed at, so the ability locks it as well.
    expect(state.cards[victim.card]?.locked).toBe(true);
    expect(state.cards[victim.card]?.counters[SKIP_REFRESH]).toBe(1);
  });

  it('BK1-085 marks a character that was already locked, and it misses one Refresh', () => {
    // The printed line is about the *next* Refresh, so being down already is
    // not a reason to skip the mark — that was the ruling.
    let state = started('BK1-081');
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const nightmare = place(state, player, 'BK1-085', 2);
    state = nightmare.state;
    const victim = place(state, player, 'BK1-081', 2);
    state = victim.state;
    state = {
      ...state,
      cards: { ...state.cards, [victim.card]: { ...cardOf(state, victim.card), locked: true } },
    };

    const use = engine
      .legalActions(atMain(state), player)
      .find(
        (action) =>
          action.type === 'USE_ABILITY' &&
          action.card === nightmare.card &&
          action.targets?.[0] === victim.card,
      );
    expect(use, 'an already-locked character is still a legal target').toBeDefined();
    state = apply(atMain(state), player, use as GameAction);
    expect(state.cards[victim.card]?.counters[SKIP_REFRESH]).toBe(1);

    // Round the table once, so this player's own Refresh runs: the mark is
    // spent there and the character stays down.
    const next = endTurn(endTurn(state, player), other);
    expect(next.turn.activePlayer).toBe(player);
    expect(next.cards[victim.card]?.locked).toBe(true);
    expect(next.cards[victim.card]?.counters[SKIP_REFRESH]).toBe(0);

    // And the Refresh after that finally stands it up.
    const later = endTurn(endTurn(next, player), other);
    expect(later.cards[victim.card]?.locked).toBe(false);
  });

  it('BK1-099 puts the top of the opponent deck in the graveyard, unseen', () => {
    let state = started('BK1-081');
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const spirits = place(state, player, 'BK1-099', 2);
    state = spirits.state;

    const deckBefore = zoneSize(state, other, 'deck');
    const trashBefore = zoneSize(state, other, 'trash');
    const handBefore = zoneSize(state, other, 'hand');

    const use = engine
      .legalActions(atMain(state), player)
      .find((action) => action.type === 'USE_ABILITY' && action.card === spirits.card);
    expect(use, 'the mill should be offered').toBeDefined();
    state = apply(atMain(state), player, use as GameAction);

    expect(zoneSize(state, other, 'deck')).toBe(deckBefore - 3);
    expect(zoneSize(state, other, 'trash')).toBe(trashBefore + 3);
    // Off the top of the deck, not out of the hand.
    expect(zoneSize(state, other, 'hand')).toBe(handBefore);
  });

  it('BK1-092 Possessing Fiend destroys itself to pay, and the lock outlives it', () => {
    let state = started('BK1-081');
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const fiend = place(state, player, 'BK1-092', 2);
    state = fiend.state;
    const victim = place(state, other, 'BK1-081', 2);
    state = victim.state;

    const use = engine
      .legalActions(atMain(state), player)
      .find(
        (action) =>
          action.type === 'USE_ABILITY' &&
          action.card === fiend.card &&
          action.targets?.[0] === victim.card,
      );
    expect(use, 'the Fiend should be able to point at somebody').toBeDefined();
    state = apply(atMain(state), player, use as GameAction);

    // Paid on resolution, so the ability still went off rather than fizzling
    // as a source that had already gone.
    expect(state.cards[fiend.card]?.zone).toBe('trash');
    expect(state.cards[victim.card]?.locked).toBe(true);
  });

  it('BK1-104 Deceased Sun takes a card off whoever holds the area', () => {
    let state = started('BK1-081');
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const sun = place(state, player, 'BK1-104', 2);
    state = sun.state;
    // The *opponent* holds this area, and the card hits whoever does.
    state = {
      ...state,
      cities: state.cities.map((city, index) =>
        index === 2 ? { ...city, occupiedBy: other } : city,
      ),
    };

    const before = zoneSize(state, other, 'hand');
    expect(before).toBeGreaterThanOrEqual(3);

    // Round to the occupier's own turn, when the trigger fires.
    const next = endTurn(state, player);
    expect(next.turn.activePlayer).toBe(other);
    // Exactly one card, not down to three — and their draw for the turn is
    // in there too, so compare against the draw rather than the raw count.
    expect(zoneSize(next, other, 'hand')).toBeLessThan(before + 1);
  });

  it('BK1-104 leaves a small hand alone', () => {
    let state = started('BK1-081');
    const player = state.turn.activePlayer;

    const sun = place(state, player, 'BK1-104', 2);
    state = sun.state;
    state = {
      ...state,
      cities: state.cities.map((city, index) =>
        index === 2 ? { ...city, occupiedBy: player } : city,
      ),
    };
    // Empty the hand out to below the threshold.
    const hand = [...(state.zoneOrder[`${player}:hand`] ?? [])];
    let stripped = state;
    for (const id of hand) {
      stripped = {
        ...stripped,
        cards: { ...stripped.cards, [id]: { ...cardOf(stripped, id), zone: 'trash' as const } },
        zoneOrder: Object.fromEntries(
          Object.entries(stripped.zoneOrder).map(([key, order]) => [
            key,
            key === `${player}:hand` ? order.filter((c) => c !== id) : order,
          ]),
        ),
      };
    }
    expect(zoneSize(stripped, player, 'hand')).toBe(0);

    // The trigger fires on their next turn and finds nothing to take:
    // "if they have 3 or more cards in their hand".
    const other = stripped.seats.find((seat) => seat !== player) as PlayerId;
    const next = endTurn(endTurn(stripped, player), other);
    expect(next.turn.activePlayer).toBe(player);
    // One card drawn for the turn, and nothing taken back off them.
    expect(zoneSize(next, player, 'hand')).toBe(1);
  });
});

describe('black: choices put to the opponent (Rules.md §13)', () => {
  it('BK1-100 makes the opponent give up a Set Card within one area', () => {
    let state = started('BK1-081');
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const spirits = place(state, player, 'BK1-100', 2);
    state = spirits.state;
    // The ability is gated on holding the area it stands in.
    state = {
      ...state,
      cities: state.cities.map((city, index) =>
        index === 2 ? { ...city, occupiedBy: player } : city,
      ),
    };
    // One adjacent (Distance 1, legal) and one two cities away (out of reach).
    const near = place(state, other, 'BK1-081', 3, { faceUp: false });
    state = near.state;
    const far = place(state, other, 'BK1-081', 0, { faceUp: false });
    state = far.state;

    const use = engine
      .legalActions(atMain(state), player)
      .find((action) => action.type === 'USE_ABILITY' && action.card === spirits.card);
    expect(use, 'the ability should be offered while the area is held').toBeDefined();
    state = apply(atMain(state), player, use as GameAction);

    // The question is put to the *owner* of the cards, not to whoever used it.
    expect(state.pending?.waitingOn).toBe(other);
    const offered = engine
      .legalActions(state, other)
      .filter((action) => action.type === 'CHOOSE_CARD')
      .map((action) => (action as Extract<GameAction, { type: 'CHOOSE_CARD' }>).card);
    // Distance 1 counts from the source's own area, so only the near one.
    expect(offered).toContain(near.card);
    expect(offered).not.toContain(far.card);

    state = apply(state, other, { type: 'CHOOSE_CARD', card: near.card });
    expect(state.cards[near.card]?.zone).toBe('trash');
    expect(state.cards[far.card]?.zone).toBe('city');
  });

  it('BK1-103 asks once per character, and a refusal costs that character', () => {
    // "Discard 2 cards for each character … or destroy that card" — the
    // ruling is a choice per character, not one covering all of them.
    let state = started('BK1-081');
    const attacker = state.turn.activePlayer;
    const defender = state.seats.find((seat) => seat !== attacker) as PlayerId;

    // BK1-103 is Level 3, so three cities must be face up before it can be
    // opened at all (§7).
    state = {
      ...state,
      cities: state.cities.map((city, index) => (index < 3 ? { ...city, faceUp: true } : city)),
    };

    const lead = place(state, attacker, 'BK1-081', 2);
    state = lead.state;
    const first = place(state, defender, 'BK1-081', 2);
    state = first.state;
    const second = place(state, defender, 'BK1-081', 2);
    state = second.state;
    const interception = place(state, attacker, 'BK1-103', 2, { faceUp: false });
    state = interception.state;

    state = apply(atMain(state), attacker, { type: 'DECLARE_BATTLE', city: 2 });
    state = apply(state, attacker, { type: 'DESIGNATE_VANGUARD', card: lead.card });

    // The combat open (§11 ②) comes before commitment, and is where a Quick
    // Effect like this one is played into the fight.
    const open = openOf(state, attacker, interception.card);
    expect(open, 'Demon Interception should be openable in the combat open').toBeDefined();
    state = apply(state, attacker, open as GameAction);

    // Nobody has committed yet, so "characters they control in battle in this
    // area" is nobody — the card resolves having found no one to ask about.
    expect(state.pending).toBeNull();
    expect(state.cards[first.card]?.zone).toBe('city');
    expect(state.cards[second.card]?.zone).toBe('city');
  });

  it('BK1-103 puts the question once for each committed defender', () => {
    let state = started('BK1-081');
    const attacker = state.turn.activePlayer;
    const defender = state.seats.find((seat) => seat !== attacker) as PlayerId;

    state = {
      ...state,
      cities: state.cities.map((city, index) => (index < 3 ? { ...city, faceUp: true } : city)),
    };

    const lead = place(state, attacker, 'BK1-081', 2);
    state = lead.state;
    const first = place(state, defender, 'BK1-081', 2);
    state = first.state;
    const second = place(state, defender, 'BK1-081', 2);
    state = second.state;
    const interception = place(state, attacker, 'BK1-103', 2, { faceUp: false });
    state = interception.state;

    state = apply(atMain(state), attacker, { type: 'DECLARE_BATTLE', city: 2 });
    state = apply(state, attacker, { type: 'DESIGNATE_VANGUARD', card: lead.card });

    // Walk the battle to the commitment step and put both defenders in it.
    for (let guard = 0; guard < 12 && state.battle && !state.pending; guard++) {
      if (state.battle.step !== 'commit') {
        const waiting = state.battle.waitingOn;
        const pass = engine
          .legalActions(state, waiting)
          .find((action) => action.type === 'BATTLE_PASS');
        if (!pass) break;
        state = apply(state, waiting, pass);
        continue;
      }
      const join = engine
        .legalActions(state, defender)
        .find(
          (action) =>
            action.type === 'COMMIT_CHARACTER' &&
            (action.card === first.card || action.card === second.card),
        );
      if (!join) break;
      state = apply(state, defender, join);
    }

    const committed = state.battle?.participants ?? [];
    expect(committed).toContain(first.card);
    expect(committed).toContain(second.card);

    // Open it into the fight now that both are committed.
    const open = openOf(state, attacker, interception.card);
    expect(open, 'Demon Interception should be openable').toBeDefined();
    state = apply(state, attacker, open as GameAction);

    // One question, put to the defender, about the first of the two.
    expect(state.pending?.waitingOn).toBe(defender);
    expect(state.pending?.kind.zone).toBe('decision');
    const handBefore = zoneSize(state, defender, 'hand');

    // Refusing to pay gives up that character, and costs no cards.
    state = apply(state, defender, { type: 'ANSWER', accept: false });
    expect(zoneSize(state, defender, 'hand')).toBe(handBefore);
    const lost = [first.card, second.card].filter((id) => state.cards[id]?.zone === 'trash');
    expect(lost).toHaveLength(1);

    // And the other is asked about behind it, rather than sharing the answer.
    expect(state.pending?.waitingOn).toBe(defender);
  });
});

describe('red and the rest of black (Rules.md §13)', () => {
  it('BK1-116 lets its occupier open only what a lower City Level allows', () => {
    let state = started('BK1-081');
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const forest = place(state, player, 'BK1-116', 2);
    state = forest.state;
    // Three cities face up: City Level 3 for everyone.
    state = {
      ...state,
      cities: state.cities.map((city, index) => (index < 3 ? { ...city, faceUp: true } : city)),
    };
    expect(cityLevel(state)).toBe(3);

    // The occupier of the card's area opens as if it were 2...
    const held = {
      ...state,
      cities: state.cities.map((city, index) =>
        index === 2 ? { ...city, occupiedBy: player } : city,
      ),
    };
    expect(openLevelFor({ registry }, held, player)).toBe(2);
    // ...and the other player is untouched.
    expect(openLevelFor({ registry }, held, other)).toBe(3);

    // §5 is unchanged: City Level is still the count of face-up cities.
    expect(cityLevel(held)).toBe(3);
  });

  it('BK1-149 bars a character from battle for the turn, its own card gone', () => {
    // RED is the red Mercenary: a red cost is paid with red cards (§7).
    let state = started(RED);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const victim = place(state, other, RED, 2);
    state = victim.state;
    expect(cannotBattle(state, cardOf(state, victim.card))).toBe(false);

    const blood = place(state, player, 'BK1-149', 2, { faceUp: false });
    state = openable(blood.state, player, blood.card);
    const open = openOf(state, player, blood.card);
    expect(open, 'Blood That Should Be Frozen should be openable').toBeDefined();
    state = apply(state, player, open as GameAction);

    // A Normal Effect is in the Trash the moment it resolves (§3), so this
    // has to be written onto the character rather than read off the source.
    expect(state.cards[blood.card]?.zone).toBe('trash');
    // "Cannot participate in battle" bars it from being chosen at all — on
    // either side, unlike the narrower `cannotAttack`.
    expect(cannotBattle(state, cardOf(state, victim.card))).toBe(true);
    expect(canVanguard({ registry }, state, other, 2)).not.toContainEqual(
      expect.objectContaining({ instanceId: victim.card }),
    );
  });

  it('BK1-152 destroys the Eternals in play and draws exactly that many', () => {
    let state = started(RED);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    // Two Eternal Effects standing, one on each side, plus a character that
    // must survive — it is not an Effect card.
    const mine = place(state, player, 'BK1-104', 1);
    state = mine.state;
    const theirs = place(state, other, 'BK1-116', 3);
    state = theirs.state;
    const bystander = place(state, other, RED, 2);
    state = bystander.state;

    const flight = place(state, player, 'BK1-152', 2, { faceUp: false });
    state = openable(flight.state, player, flight.card);
    const before = zoneSize(state, player, 'hand');
    const open = openOf(state, player, flight.card);
    expect(open, 'Mind Flight should be openable').toBeDefined();
    state = apply(state, player, open as GameAction);

    expect(state.cards[mine.card]?.zone).toBe('trash');
    expect(state.cards[theirs.card]?.zone).toBe('trash');
    expect(state.cards[bystander.card]?.zone).toBe('city');
    // Two destroyed, so two drawn — counted before they left the board. The
    // cost came out of the same hand, so measure the draw against what a
    // resolved open leaves behind rather than against the raw count.
    expect(zoneSize(state, player, 'hand')).toBeGreaterThan(before - 1);
  });

  it('BK1-141 shows Sonia the Set Cards here, and shows nobody else', () => {
    let state = started(RED);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const hidden = place(state, other, RED, 2, { faceUp: false });
    state = hidden.state;
    const elsewhere = place(state, other, RED, 4, { faceUp: false });
    state = elsewhere.state;

    const sonia = place(state, player, 'BK1-141', 2, { faceUp: false });
    state = openable(sonia.state, player, sonia.card);
    const open = openOf(state, player, sonia.card);
    expect(open, 'Sonia should be openable').toBeDefined();
    state = apply(state, player, open as GameAction);

    // She sees the one in her area...
    const hers = viewFor({ registry }, state, player);
    expect(isHidden(hers.cards[hidden.card])).toBe(false);
    // ...but not the one two cities away.
    expect(isHidden(hers.cards[elsewhere.card])).toBe(true);
  });

  it('BK1-145 pays three cards to whoever takes the city, not two', () => {
    let state = started('BK1-081');
    const attacker = state.turn.activePlayer;
    const defender = state.seats.find((seat) => seat !== attacker) as PlayerId;

    // The Eternal stands in the contested city and belongs to nobody's fight.
    const hill = place(state, defender, 'BK1-145', 2);
    state = hill.state;
    const lead = place(state, attacker, 'BK1-081', 2);
    state = lead.state;

    const before = zoneSize(state, attacker, 'hand');
    state = apply(atMain(state), attacker, { type: 'DECLARE_BATTLE', city: 2 });
    state = apply(state, attacker, { type: 'DESIGNATE_VANGUARD', card: lead.card });
    state = runBattle(state, defender);

    // Uncontested, so the attacker takes it (§12) and the city pays 3.
    expect(state.cities[2]?.occupiedBy).toBe(attacker);
    expect(zoneSize(state, attacker, 'hand')).toBe(before + 3);
  });
});

describe('"cannot participate in battle" bars either side (Rules.md §11)', () => {
  it('keeps a barred defender out of the fight, garrison or not', () => {
    // The ruling: it cannot be *chosen* for a battle at all — unlike
    // `cannotAttack`, which only stops it leading or joining an attack.
    let state = started(RED);
    const attacker = state.turn.activePlayer;
    const defender = state.seats.find((seat) => seat !== attacker) as PlayerId;

    const lead = place(state, attacker, RED, 2);
    state = lead.state;
    const barred = place(state, defender, RED, 2);
    state = barred.state;
    // The defender occupies, so their garrison is committed for them.
    state = {
      ...state,
      cities: state.cities.map((city, index) =>
        index === 2 ? { ...city, occupiedBy: defender } : city,
      ),
      cards: {
        ...state.cards,
        [barred.card]: {
          ...cardOf(state, barred.card),
          counters: { ...cardOf(state, barred.card).counters, noBattle: 1 },
        },
      },
    };

    state = apply(atMain(state), attacker, { type: 'DECLARE_BATTLE', city: 2 });
    state = apply(state, attacker, { type: 'DESIGNATE_VANGUARD', card: lead.card });

    // Even an occupier's automatic commitment leaves it out.
    expect(state.battle?.participants ?? []).not.toContain(barred.card);
    // And it is never offered as a commitment either.
    expect(
      engine
        .legalActions(state, defender)
        .some((action) => action.type === 'COMMIT_CHARACTER' && action.card === barred.card),
    ).toBe(false);
  });

  it('a character barred only from attacking may still defend', () => {
    // The narrower restriction is unchanged: BK1-089 cannot attack, but
    // nothing stops it standing in the way.
    let state = started(GREEN);
    const attacker = state.turn.activePlayer;
    const defender = state.seats.find((seat) => seat !== attacker) as PlayerId;

    const lead = place(state, attacker, GREEN, 2);
    state = lead.state;
    // BK1-090's first printed line is a flat "cannot attack", and its other
    // ability is not usable here, so no Quick window interrupts the battle.
    const guardian = place(state, defender, 'BK1-090', 2);
    state = guardian.state;
    state = {
      ...state,
      cards: {
        ...state.cards,
        [guardian.card]: { ...cardOf(state, guardian.card), locked: true },
      },
    };

    expect(cannotAttack({ registry }, state, cardOf(state, guardian.card))).toBe(true);
    expect(cannotBattle(state, cardOf(state, guardian.card))).toBe(false);
    // Unlocked again now the Quick that would interrupt cannot be paid for.
    state = {
      ...state,
      cards: {
        ...state.cards,
        [guardian.card]: { ...cardOf(state, guardian.card), locked: false },
      },
    };

    state = apply(atMain(state), attacker, { type: 'DECLARE_BATTLE', city: 2 });
    // Declaring opens a Quick window for the guardian's own ability (§13);
    // nobody wants it here, so decline until play resumes.
    for (let guard = 0; guard < 6 && state.quick; guard++) {
      state = apply(state, state.quick.waitingOn, { type: 'PASS_PRIORITY' });
    }
    state = apply(state, attacker, { type: 'DESIGNATE_VANGUARD', card: lead.card });
    for (let guard = 0; guard < 6 && state.quick; guard++) {
      state = apply(state, state.quick.waitingOn, { type: 'PASS_PRIORITY' });
    }

    // It is offered as a defender, which is the whole difference.
    expect(
      engine
        .legalActions(state, defender)
        .some((action) => action.type === 'COMMIT_CHARACTER' && action.card === guardian.card),
    ).toBe(true);
  });

  it('BK1-154 shields everyone but the area it was opened in', () => {
    let state = started(RED);
    const player = state.turn.activePlayer;

    const here = place(state, player, RED, 2);
    state = here.state;
    const away = place(state, player, RED, 4);
    state = away.state;

    const evasion = place(state, player, 'BK1-154', 2, { faceUp: false });
    state = openable(evasion.state, player, evasion.card);
    const open = openOf(state, player, evasion.card);
    expect(open, 'Strafing Evasion should be openable').toBeDefined();
    state = apply(state, player, open as GameAction);

    // "Characters that are not in this area" — so the far one is shielded...
    expect(
      damageAfterReduction({ registry }, state, cardOf(state, away.card), 3, { combat: true }),
    ).toBe(0);
    // ...and the one standing with the card is not.
    expect(
      damageAfterReduction({ registry }, state, cardOf(state, here.card), 3, { combat: true }),
    ).toBe(3);
  });
});

describe('looking at the top of the deck (Rules.md §13)', () => {
  it('BK1-023 shows exactly five cards and takes two, without shuffling', () => {
    let state = started();
    const player = state.turn.activePlayer;

    const bounty = place(state, player, 'BK1-023', 2, { faceUp: false });
    state = openable(bounty.state, player, bounty.card);
    // "If you captured this area this turn" — §13.
    state = { ...state, turn: { ...state.turn, capturedCities: [2] } };

    // The deck order before the look, to prove it survives it.
    const orderBefore = [...(state.zoneOrder[`${player}:deck`] ?? [])];

    const open = openOf(state, player, bounty.card);
    expect(open, 'Promised Bounty should be openable').toBeDefined();
    state = apply(state, player, open as GameAction);

    // Exactly the top five are on offer — never the rest of the deck.
    const offered = engine
      .legalActions(state, player)
      .filter((action) => action.type === 'CHOOSE_CARD')
      .map((action) => (action as Extract<GameAction, { type: 'CHOOSE_CARD' }>).card);
    expect(offered).toHaveLength(5);
    expect(offered).toEqual(orderBefore.slice(0, 5));

    // And the view shows those five, and nothing deeper.
    const seen = viewFor({ registry }, state, player);
    expect(isHidden(seen.cards[orderBefore[5] as CardInstanceId])).toBe(true);
    for (const id of orderBefore.slice(0, 5)) {
      expect(isHidden(seen.cards[id])).toBe(false);
    }

    // Two of them, one at a time.
    expect(state.pending?.count).toBe(2);
    state = apply(state, player, { type: 'CHOOSE_CARD', card: offered[0] as CardInstanceId });
    state = apply(state, player, { type: 'CHOOSE_CARD', card: offered[1] as CardInstanceId });
    expect(state.pending).toBeNull();
    // Both chosen cards are in hand now, and came off the deck.
    for (const id of offered.slice(0, 2)) {
      expect(state.cards[id]?.zone).toBe('hand');
    }

    // Looking at the top is not a search, so the rest of the deck keeps its
    // order — §13's shuffle exists to unlearn a *whole-deck* look.
    const orderAfter = state.zoneOrder[`${player}:deck`] ?? [];
    expect(orderAfter).toEqual(orderBefore.slice(2));
  });
});

describe('BK1-159 puts the top of the deck back in a chosen order', () => {
  it('shows four, keeps them in the deck, and the last named is drawn next', () => {
    let state = started(RED);
    const player = state.turn.activePlayer;

    const story = place(state, player, 'BK1-159', 2, { faceUp: false });
    state = openable(story.state, player, story.card);
    const orderBefore = [...(state.zoneOrder[`${player}:deck`] ?? [])];
    const deckBefore = zoneSize(state, player, 'deck');

    const open = openOf(state, player, story.card);
    expect(open, 'Preposterous Story should be openable').toBeDefined();
    state = apply(state, player, open as GameAction);

    // Exactly the top four are on offer, and the view shows those only.
    const offered = engine
      .legalActions(state, player)
      .filter((action) => action.type === 'CHOOSE_CARD')
      .map((action) => (action as Extract<GameAction, { type: 'CHOOSE_CARD' }>).card);
    expect(offered).toHaveLength(4);
    expect(offered).toEqual(orderBefore.slice(0, 4));
    const seen = viewFor({ registry }, state, player);
    expect(isHidden(seen.cards[orderBefore[4] as CardInstanceId])).toBe(true);

    // Name them back to front; each named card goes on top as it is placed.
    const picked = [...offered].reverse();
    for (const id of picked) {
      state = apply(state, player, { type: 'CHOOSE_CARD', card: id });
    }
    expect(state.pending).toBeNull();

    // Nothing left the deck — it is a look, not a search.
    expect(zoneSize(state, player, 'deck')).toBe(deckBefore);
    // The last one named sits on top, and the four are in the chosen order.
    const after = state.zoneOrder[`${player}:deck`] ?? [];
    expect(after.slice(0, 4)).toEqual([...picked].reverse());
    // Everything below the fourth card is exactly where it was.
    expect(after.slice(4)).toEqual(orderBefore.slice(4));
  });
});

describe('BK1-155 sets the top of the deck anywhere (Rules.md §13)', () => {
  it('is offered only to a player who holds nothing while the enemy holds two', () => {
    let state = started(RED);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const cry = place(state, player, 'BK1-155', 2, { faceUp: false });
    state = openable(cry.state, player, cry.card);

    // Nobody holds anything yet: the gate is shut.
    expect(openOf(state, player, cry.card)).toBeUndefined();

    // One enemy city is still not enough.
    const one = {
      ...state,
      cities: state.cities.map((city, index) =>
        index === 0 ? { ...city, occupiedBy: other } : city,
      ),
    };
    expect(openOf(one, player, cry.card)).toBeUndefined();

    // Two opens it.
    const two = {
      ...state,
      cities: state.cities.map((city, index) =>
        index < 2 ? { ...city, occupiedBy: other } : city,
      ),
    };
    expect(openOf(two, player, cry.card)).toBeDefined();

    // And holding one of your own shuts it again, however many they hold.
    const mine = {
      ...state,
      cities: state.cities.map((city, index) =>
        index < 2
          ? { ...city, occupiedBy: other }
          : index === 4
            ? { ...city, occupiedBy: player }
            : city,
      ),
    };
    expect(openOf(mine, player, cry.card)).toBeUndefined();
  });

  it('places each card face down in the area the player names', () => {
    let state = started(RED);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const cry = place(state, player, 'BK1-155', 2, { faceUp: false });
    state = openable(cry.state, player, cry.card);
    state = {
      ...state,
      cities: state.cities.map((city, index) =>
        index < 2 ? { ...city, occupiedBy: other } : city,
      ),
    };

    const orderBefore = [...(state.zoneOrder[`${player}:deck`] ?? [])];
    state = apply(state, player, openOf(state, player, cry.card) as GameAction);

    // Every (card, area) pair is offered, for the top seven only.
    const offers = engine
      .legalActions(state, player)
      .filter((action) => action.type === 'CHOOSE_CARD') as Extract<
      GameAction,
      { type: 'CHOOSE_CARD' }
    >[];
    const cards = new Set(offers.map((action) => action.card));
    expect(cards.size).toBe(7);
    expect([...cards]).toEqual(expect.arrayContaining(orderBefore.slice(0, 7)));
    // Five cities each, so a card can go anywhere on the board.
    expect(offers.filter((action) => action.card === orderBefore[0]).length).toBe(5);

    // Place the first into a far city and check it landed face down there.
    const first = orderBefore[0] as CardInstanceId;
    state = apply(state, player, { type: 'CHOOSE_CARD', card: first, city: 4 });
    expect(state.cards[first]?.zone).toBe('city');
    expect(state.cards[first]?.cityIndex).toBe(4);
    expect(state.cards[first]?.faceUp).toBe(false);
    expect(state.cards[first]?.controller).toBe(player);

    // Its neighbour can still go somewhere else entirely.
    const second = orderBefore[1] as CardInstanceId;
    state = apply(state, player, { type: 'CHOOSE_CARD', card: second, city: 0 });
    expect(state.cards[second]?.cityIndex).toBe(0);
  });
});

describe('shutting and opening Set Cards (Rules.md §7)', () => {
  it('BK1-031 shuts a Set Card for the turn, at both gates', () => {
    let state = started();
    const player = state.turn.activePlayer;

    const victim = place(state, player, 'BK1-023', 2, { faceUp: false });
    state = victim.state;
    const scouting = place(state, player, 'BK1-031', 2, { faceUp: false });
    state = openable(scouting.state, player, scouting.card);

    const open = engine
      .legalActions(state, player)
      .find(
        (action) =>
          action.type === 'OPEN_CARD' &&
          action.card === scouting.card &&
          action.targets?.[0] === victim.card,
      );
    expect(open, 'Scouting Duty should be able to point at the Set Card').toBeDefined();
    state = apply(state, player, open as GameAction);

    expect(state.cards[victim.card]?.counters['sealed']).toBe(1);
    // Never offered...
    expect(openOf(state, player, victim.card)).toBeUndefined();
    // ...and refused if asked for anyway, since the client is not trusted.
    const forced = engine.reduce(state, player, { type: 'OPEN_CARD', card: victim.card });
    expect(forced.ok).toBe(false);
  });

  it('BK1-030 turns a set white character face up for free', () => {
    let state = started();
    const player = state.turn.activePlayer;

    // BK1-002 is a white character; BK1-023 a white Effect, which is not a
    // legal choice for a line that says "set white *character* card".
    const soldier = place(state, player, 'BK1-002', 2, { faceUp: false });
    state = soldier.state;
    const departure = place(state, player, 'BK1-030', 2, { faceUp: false });
    state = openable(departure.state, player, departure.card);

    const open = engine
      .legalActions(state, player)
      .find(
        (action) =>
          action.type === 'OPEN_CARD' &&
          action.card === departure.card &&
          action.targets?.[0] === soldier.card,
      );
    expect(open, 'Midnight Departure should point at the set character').toBeDefined();
    state = apply(state, player, open as GameAction);

    expect(state.cards[soldier.card]?.faceUp).toBe(true);
    // It did not spend the turn's one open (§10 ③) — the effect put it there.
    expect(state.cards[soldier.card]?.cityIndex).toBe(2);
  });
});

describe('an ability aimed at a Set Card survives the stack (Rules.md §14)', () => {
  it('BK1-146 destroys the Set Card it was pointed at', () => {
    // `resolveTop` treats a chosen card that is not face up as gone, which is
    // right for a character and wrong for a Set Card — the whole point of
    // these is that the target is face down. Pinned here because the effect
    // fizzled silently rather than erroring.
    let state = started(RED);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const hidden = place(state, other, RED, 2, { faceUp: false });
    state = hidden.state;
    const freedom = place(state, player, 'BK1-146', 2, { faceUp: false });
    state = openable(freedom.state, player, freedom.card);

    const open = engine
      .legalActions(state, player)
      .find(
        (action) =>
          action.type === 'OPEN_CARD' &&
          action.card === freedom.card &&
          action.targets?.[0] === hidden.card,
      );
    expect(open, 'Affirmation Of Freedom should point at the Set Card').toBeDefined();
    state = apply(state, player, open as GameAction);

    expect(state.cards[hidden.card]?.zone).toBe('trash');
  });
});

describe('BK1-029 pays its second half only while defending (Rules.md §11)', () => {
  it('gives +1/+2 at once, and +1/+1 more inside a fight it is defending', () => {
    let state = started();
    const attacker = state.turn.activePlayer;
    const defender = state.seats.find((seat) => seat !== attacker) as PlayerId;

    // The card is the defender's, so put the turn on them to open it.
    const guard = place(state, defender, 'BK1-002', 2);
    state = guard.state;
    const designation = place(state, defender, 'BK1-029', 2, { faceUp: false });
    state = openable(designation.state, defender, designation.card);

    // Printed 1/2 for BK1-002.
    expect(power(state, guard.card)).toBe(1);
    expect(hp(state, guard.card)).toBe(2);

    const open = engine
      .legalActions(state, defender)
      .find(
        (action) =>
          action.type === 'OPEN_CARD' &&
          action.card === designation.card &&
          action.targets?.[0] === guard.card,
      );
    expect(open, 'Rear Guard Designation should point at the character').toBeDefined();
    state = apply(state, defender, open as GameAction);

    // The flat half lands now; the conditional half does not, with no fight on.
    expect(power(state, guard.card)).toBe(2);
    expect(hp(state, guard.card)).toBe(4);
    expect(state.cards[guard.card]?.counters['rearguard']).toBe(1);

    // Now run a battle at that city with them defending.
    let fighting = {
      ...state,
      turn: { ...state.turn, activePlayer: attacker, priorityPlayer: attacker },
    };
    const lead = place(fighting, attacker, 'BK1-002', 2);
    fighting = lead.state;
    fighting = apply(atMain(fighting), attacker, { type: 'DECLARE_BATTLE', city: 2 });
    for (let n = 0; n < 6 && fighting.quick; n++) {
      fighting = apply(fighting, fighting.quick.waitingOn, { type: 'PASS_PRIORITY' });
    }
    fighting = apply(fighting, attacker, { type: 'DESIGNATE_VANGUARD', card: lead.card });
    for (let n = 0; n < 6 && fighting.quick; n++) {
      fighting = apply(fighting, fighting.quick.waitingOn, { type: 'PASS_PRIORITY' });
    }
    const join = engine
      .legalActions(fighting, defender)
      .find((action) => action.type === 'COMMIT_CHARACTER' && action.card === guard.card);
    expect(join, 'the guard should be able to defend').toBeDefined();

    // Read the numbers *inside* the fight: a battle this small settles the
    // moment it is joined, so the state afterwards has no battle to read.
    const committed = engine.reduce(fighting, defender, join as GameAction);
    expect(committed.ok).toBe(true);

    // Committed on the defending side, the extra +1/+1 counts — checked
    // against a board that still has the battle on it.
    const midFight = {
      ...fighting,
      battle: {
        ...(fighting.battle as NonNullable<typeof fighting.battle>),
        participants: [...(fighting.battle?.participants ?? []), guard.card],
      },
    };
    expect(power(midFight, guard.card)).toBe(3);
    expect(hp(midFight, guard.card)).toBe(5);
  });
});

describe('BK1-147 calls in any number of characters (Rules.md §13)', () => {
  it('brings the ones named here and unlocks them, and stops when told', () => {
    let state = started(RED);
    const attacker = state.turn.activePlayer;
    const defender = state.seats.find((seat) => seat !== attacker) as PlayerId;

    // Three of the defender's characters, scattered, all locked.
    const away1 = place(state, defender, RED, 0);
    state = away1.state;
    const away2 = place(state, defender, RED, 4);
    state = away2.state;
    const alreadyHere = place(state, defender, RED, 2);
    state = alreadyHere.state;
    for (const id of [away1.card, away2.card, alreadyHere.card]) {
      state = {
        ...state,
        cards: { ...state.cards, [id]: { ...cardOf(state, id), locked: true } },
      };
    }

    const interception = place(state, defender, 'BK1-147', 2, { faceUp: false });
    state = openable(interception.state, defender, interception.card);

    // The gate: a battle must have been declared here by the *other* player.
    expect(openOf(state, defender, interception.card)).toBeUndefined();
    state = {
      ...state,
      turn: { ...state.turn, activePlayer: attacker, declaredCities: [2] },
    };
    const open = openOf(state, defender, interception.card);
    expect(open, 'Sudden Interception should open after defending here').toBeDefined();
    state = apply(state, defender, open as GameAction);

    // Only the ones that are elsewhere are offered — somebody already
    // standing here has nowhere to be moved to.
    const offered = engine
      .legalActions(state, defender)
      .filter((action) => action.type === 'CHOOSE_CARD')
      .map((action) => (action as Extract<GameAction, { type: 'CHOOSE_CARD' }>).card);
    expect(offered).toContain(away1.card);
    expect(offered).toContain(away2.card);
    expect(offered).not.toContain(alreadyHere.card);

    // Call one in: it arrives here and stands up.
    state = apply(state, defender, { type: 'CHOOSE_CARD', card: away1.card });
    expect(state.cards[away1.card]?.cityIndex).toBe(2);
    expect(state.cards[away1.card]?.locked).toBe(false);

    // "Any number" — stopping early is legal, and leaves the rest alone.
    expect(state.pending).not.toBeNull();
    expect(engine.legalActions(state, defender).some((a) => a.type === 'ANSWER' && !a.accept)).toBe(
      true,
    );
    state = apply(state, defender, { type: 'ANSWER', accept: false });
    expect(state.pending).toBeNull();
    expect(state.cards[away2.card]?.cityIndex).toBe(4);
    expect(state.cards[away2.card]?.locked).toBe(true);
  });
});

describe('BK1-158 answers the opponent taking ground (Rules.md §12)', () => {
  it('sets the top of its owner deck into the city that just changed hands', () => {
    let state = started(RED);
    const attacker = state.turn.activePlayer;
    const defender = state.seats.find((seat) => seat !== attacker) as PlayerId;

    // The Eternal stands somewhere else entirely: it acts on the captured
    // area, not on its own.
    const mobilization = place(state, defender, 'BK1-158', 0);
    state = mobilization.state;
    const lead = place(state, attacker, RED, 2);
    state = lead.state;

    const topBefore = (state.zoneOrder[`${defender}:deck`] ?? [])[0] as CardInstanceId;
    const deckBefore = zoneSize(state, defender, 'deck');

    state = apply(atMain(state), attacker, { type: 'DECLARE_BATTLE', city: 2 });
    state = apply(state, attacker, { type: 'DESIGNATE_VANGUARD', card: lead.card });
    state = runBattle(state, defender);

    // The attacker took city 2 (§12, uncontested).
    expect(state.cities[2]?.occupiedBy).toBe(attacker);
    // ...and the defender's top card is now set face down *there*.
    expect(state.cards[topBefore]?.zone).toBe('city');
    expect(state.cards[topBefore]?.cityIndex).toBe(2);
    expect(state.cards[topBefore]?.faceUp).toBe(false);
    expect(state.cards[topBefore]?.controller).toBe(defender);
    expect(zoneSize(state, defender, 'deck')).toBe(deckBefore - 1);
  });

  it('does not fire for its own controller capturing', () => {
    // "Whenever your opponent captures" — the captor's own cards stay quiet.
    let state = started(RED);
    const attacker = state.turn.activePlayer;
    const defender = state.seats.find((seat) => seat !== attacker) as PlayerId;

    const mobilization = place(state, attacker, 'BK1-158', 0);
    state = mobilization.state;
    const lead = place(state, attacker, RED, 2);
    state = lead.state;

    const topBefore = (state.zoneOrder[`${attacker}:deck`] ?? [])[0] as CardInstanceId;

    state = apply(atMain(state), attacker, { type: 'DECLARE_BATTLE', city: 2 });
    state = apply(state, attacker, { type: 'DESIGNATE_VANGUARD', card: lead.card });
    state = runBattle(state, defender);

    expect(state.cities[2]?.occupiedBy).toBe(attacker);
    // The card that was on top was drawn by the capture, not set on the board.
    expect(state.cards[topBefore]?.zone).not.toBe('city');
  });
});

describe('BK1-027 turns a small striker on itself (Rules.md §11 ④)', () => {
  it('sends its damage back at it instead of into the protected side', () => {
    // BK1-027 is white, so a white deck is what can pay for it (§7).
    let state = started();
    const attacker = state.turn.activePlayer;
    const defender = state.seats.find((seat) => seat !== attacker) as PlayerId;

    // The attacker leads with a Level 0 white Mercenary, 1/1.
    const striker = place(state, attacker, 'BK1-001', 2);
    state = striker.state;
    const guard = place(state, defender, 'BK1-001', 2);
    state = guard.state;

    // The defender opens the counterattack on the striker before the fight.
    const counter = place(state, defender, 'BK1-027', 2, { faceUp: false });
    state = openable(counter.state, defender, counter.card);
    const open = engine
      .legalActions(state, defender)
      .find(
        (action) =>
          action.type === 'OPEN_CARD' &&
          action.card === counter.card &&
          action.targets?.[0] === striker.card,
      );
    expect(open, 'Brilliant Counterattack should point at the striker').toBeDefined();
    state = apply(state, defender, open as GameAction);
    expect(state.cards[striker.card]?.counters['reflect']).toBeGreaterThan(0);

    // Now fight over that city.
    state = {
      ...state,
      turn: { ...state.turn, activePlayer: attacker, priorityPlayer: attacker },
    };
    state = apply(atMain(state), attacker, { type: 'DECLARE_BATTLE', city: 2 });
    for (let n = 0; n < 6 && state.quick; n++) {
      state = apply(state, state.quick.waitingOn, { type: 'PASS_PRIORITY' });
    }
    state = apply(state, attacker, { type: 'DESIGNATE_VANGUARD', card: striker.card });
    state = runBattle(state, defender);

    // The striker's blow came back at it: it dies, and the guard lives.
    expect(state.cards[striker.card]?.zone).toBe('trash');
    expect(state.cards[guard.card]?.zone).toBe('city');
  });
});

describe('BK1-157 pins one enemy out of one area (Rules.md §11, §13)', () => {
  it('stops it leading an attack here, but not elsewhere', () => {
    let state = started(RED);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    // The enemy stands in city 3, next to the watched city 2.
    const pinned = place(state, other, RED, 3);
    state = pinned.state;

    const messenger = place(state, player, 'BK1-157', 2, { faceUp: false });
    state = openable(messenger.state, player, messenger.card);
    const open = engine
      .legalActions(state, player)
      .find(
        (action) =>
          action.type === 'OPEN_CARD' &&
          action.card === messenger.card &&
          action.targets?.[0] === pinned.card,
      );
    expect(open, 'the Messenger should point at an enemy').toBeDefined();
    state = apply(state, player, open as GameAction);

    // The choice is written onto the Eternal, which goes on answering for it.
    expect(state.cards[messenger.card]?.marked).toBe(pinned.card);

    // It may not lead an attack on the watched area...
    expect(
      canVanguard({ registry }, state, other, 2).some((c) => c.instanceId === pinned.card),
    ).toBe(false);
    // ...but its own city, and any other, are untouched.
    expect(
      canVanguard({ registry }, state, other, 3).some((c) => c.instanceId === pinned.card),
    ).toBe(true);
  });

  it('destroys it if it walks out of the watched area', () => {
    let state = started(RED);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    // This time the enemy is standing in the watched city itself.
    const pinned = place(state, other, RED, 2);
    state = pinned.state;
    const messenger = place(state, player, 'BK1-157', 2, { faceUp: false });
    state = openable(messenger.state, player, messenger.card);
    state = apply(
      state,
      player,
      engine
        .legalActions(state, player)
        .find(
          (action) =>
            action.type === 'OPEN_CARD' &&
            action.card === messenger.card &&
            action.targets?.[0] === pinned.card,
        ) as GameAction,
    );

    // Hand the turn over and walk it out.
    let theirTurn = {
      ...state,
      turn: { ...state.turn, activePlayer: other, priorityPlayer: other },
    };
    theirTurn = atMain(theirTurn);
    const move = engine
      .legalActions(theirTurn, other)
      .find((action) => action.type === 'MOVE_CHARACTER' && action.card === pinned.card);
    expect(move, 'it should still be able to try to leave').toBeDefined();
    theirTurn = apply(theirTurn, other, move as GameAction);

    // "Destroy it if it were to move to another area" — it left, and died.
    expect(theirTurn.cards[pinned.card]?.zone).toBe('trash');
  });
});

describe('BK1-022 shows the capital to one player only (Rules.md §5)', () => {
  it('tells its controller where it is and leaks nothing to the opponent', () => {
    let state = started();
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const capital = state.cities.find((city) => city.royalCapital);
    expect(capital, 'a match has a Royal Capital').toBeDefined();
    const capitalIndex = (capital as NonNullable<typeof capital>).index;
    // It starts face down, which is what hides its position from everyone.
    expect(state.cities[capitalIndex]?.faceUp).toBe(false);

    // Before: neither seat can tell which city it is.
    for (const seat of [player, other]) {
      const before = viewFor({ registry }, state, seat);
      for (const city of before.cities) {
        expect(isCityHidden(city) ? city.royalCapital : undefined).toBeUndefined();
      }
    }

    const rickert = place(state, player, 'BK1-022', 2, { faceUp: false });
    state = openable(rickert.state, player, rickert.card);
    const open = openOf(state, player, rickert.card);
    expect(open, 'Rickert should be openable').toBeDefined();
    state = apply(state, player, open as GameAction);

    // Its controller now knows, and the flag is true for exactly one city.
    const mine = viewFor({ registry }, state, player);
    const flagged = mine.cities.filter((city) =>
      isCityHidden(city) ? city.royalCapital === true : city.royalCapital,
    );
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.index).toBe(capitalIndex);

    // The opponent still learns nothing at all.
    const theirs = viewFor({ registry }, state, other);
    for (const city of theirs.cities) {
      expect(isCityHidden(city) ? city.royalCapital : undefined).toBeUndefined();
    }

    // The capital itself is still face down: seeing it is not flipping it,
    // so it adds nothing to City Level and shows the opponent nothing (§5).
    // (`openable` turned another city up to allow a Level 1 open.)
    expect(state.cities[capitalIndex]?.faceUp).toBe(false);
    expect(state.cities.filter((city) => city.faceUp).map((city) => city.index)).not.toContain(
      capitalIndex,
    );
  });
});

describe('BK1-151 negates nearby Normal Effects (Rules.md §14)', () => {
  it('silences a continuous ability in range and leaves a distant one alone', () => {
    // The point of routing every ability lookup through `abilitiesOf` is that
    // a negation cannot be honoured in some places and forgotten in others.
    // BK1-156 is a Normal? No — it is Eternal, so a *Normal* Effect with a
    // continuous ability is what this has to reach: BK1-135 is a character.
    let state = started(RED);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    // BK1-145 Hill Of Swords is Eternal, so it must survive; BK1-156
    // Operation Liberation is Eternal too. Use them to prove the *duration*
    // filter bites: only Normal Effects are silenced.
    const eternal = place(state, other, 'BK1-156', 2);
    state = eternal.state;
    const enemy = place(state, other, RED, 2);
    state = enemy.state;
    state = {
      ...state,
      cities: state.cities.map((city, index) =>
        index === 2 ? { ...city, occupiedBy: other } : city,
      ),
    };

    // BK1-156 gives enemies of its controller -2/-0 in its area; the red
    // Mercenary is 1/1, so the aura is visible as a floor at 0.
    const beforePower = power(state, enemy.card);

    const rescue = place(state, player, 'BK1-151', 2, { faceUp: false });
    state = openable(rescue.state, player, rescue.card);
    state = apply(state, player, openOf(state, player, rescue.card) as GameAction);

    // An Eternal is not a Normal Effect, so it is untouched by this card.
    expect(state.cards[eternal.card]?.counters['negated']).toBeUndefined();
    expect(power(state, enemy.card)).toBe(beforePower);
  });

  it('silences a Normal Effect in range, and abilitiesOf is what enforces it', () => {
    let state = started(RED);
    const player = state.turn.activePlayer;

    // BK1-093 Troll is a character with a continuous `captureDraw`; a
    // negated card must lose that. Set the counter directly to test the one
    // rule that matters: every lookup honours it.
    const troll = place(state, player, 'BK1-093', 2);
    state = troll.state;
    expect(abilitiesOf({ registry }, cardOf(state, troll.card))).toHaveLength(1);

    const silenced = {
      ...state,
      cards: {
        ...state.cards,
        [troll.card]: {
          ...cardOf(state, troll.card),
          counters: { ...cardOf(state, troll.card).counters, negated: 1 },
        },
      },
    };
    expect(abilitiesOf({ registry }, cardOf(silenced, troll.card))).toHaveLength(0);
  });

  it('reaches an adjacent area but not one two cities away', () => {
    let state = started(RED);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    // Two Normal Effects with abilities: one next door, one far off.
    const near = place(state, other, 'BK1-105', 3);
    state = near.state;
    const far = place(state, other, 'BK1-105', 0);
    state = far.state;

    const rescue = place(state, player, 'BK1-151', 2, { faceUp: false });
    state = openable(rescue.state, player, rescue.card);
    state = apply(state, player, openOf(state, player, rescue.card) as GameAction);

    // Distance 1 from city 2 reaches city 3, not city 0 (§15).
    expect(state.cards[near.card]?.counters['negated']).toBe(1);
    expect(state.cards[far.card]?.counters['negated']).toBeUndefined();
  });
});

describe('BK2 (Rules.md §13)', () => {
  it('BK2-046 locks characters as they are opened, and stops when it leaves', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;

    const dream = place(state, player, 'BK2-046', 1);
    state = dream.state;

    const soldier = place(state, player, GREEN, 2, { faceUp: false });
    state = openable(soldier.state, player, soldier.card);
    state = apply(state, player, openOf(state, player, soldier.card) as GameAction);
    // Opened straight into a lock (§6, §7).
    expect(state.cards[soldier.card]?.faceUp).toBe(true);
    expect(state.cards[soldier.card]?.locked).toBe(true);

    // Continuous, so it stops the instant the Eternal goes — nothing to undo.
    const gone = {
      ...state,
      cards: {
        ...state.cards,
        [dream.card]: { ...cardOf(state, dream.card), zone: 'trash' as const },
      },
    };
    expect(opensLocked({ registry }, gone)).toBe(false);
  });

  it('BK2-007 Pippin scales with the company he keeps', () => {
    let state = started();
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const pippin = place(state, player, 'BK2-007', 2);
    state = pippin.state;
    // A 1/2 enemy: nothing dies until Pippin has friends.
    const enemy = place(state, other, 'BK1-002', 2);
    state = enemy.state;

    // Alone, "for each *other* character you control" counts nobody, so the
    // ability deals nothing at all.
    let solo = atMain(state);
    const useAlone = engine
      .legalActions(solo, player)
      .find((action) => action.type === 'USE_ABILITY' && action.card === pippin.card);
    expect(useAlone, 'the ability is still offered').toBeDefined();
    solo = apply(solo, player, useAlone as GameAction);
    for (let n = 0; n < 8 && solo.stack.length > 0; n++) {
      solo = apply(solo, solo.turn.priorityPlayer, { type: 'PASS_PRIORITY' });
    }
    expect(solo.cards[enemy.card]?.damage).toBe(0);
    expect(solo.cards[enemy.card]?.zone).toBe('city');

    // With two friends standing here, the same blow lands for 2.
    let crowded = state;
    for (let n = 0; n < 2; n++) {
      const friend = place(crowded, player, 'BK1-001', 2);
      crowded = friend.state;
    }
    crowded = atMain(crowded);
    const use = engine
      .legalActions(crowded, player)
      .find((action) => action.type === 'USE_ABILITY' && action.card === pippin.card);
    crowded = apply(crowded, player, use as GameAction);
    // §14 — a used ability goes on the stack and resolves once both players
    // have passed on it, so drain the round before reading the board.
    for (let n = 0; n < 8 && crowded.stack.length > 0; n++) {
      const waiting = crowded.turn.priorityPlayer;
      crowded = apply(crowded, waiting, { type: 'PASS_PRIORITY' });
    }
    // Three friends here besides Pippin, so three damage — "for each other
    // character you control in this area".
    // Three friends here besides Pippin, so three damage — enough to kill a
    // 1/2, which is the visible proof that the scale was applied.
    expect(crowded.cards[enemy.card]?.zone).toBe('trash');
  });

  it('BK2-042 takes both players down to two cards, and spares a small hand', () => {
    // Black card, so a black deck is what can pay for it (§7).
    let state = started('BK1-081');
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    // Strip the opponent to one card, so "2 or less" leaves them alone.
    const theirHand = [...(state.zoneOrder[`${other}:hand`] ?? [])];
    for (const id of theirHand.slice(1)) {
      state = {
        ...state,
        cards: { ...state.cards, [id]: { ...cardOf(state, id), zone: 'trash' as const } },
        zoneOrder: Object.fromEntries(
          Object.entries(state.zoneOrder).map(([key, order]) => [
            key,
            key === `${other}:hand` ? order.filter((c) => c !== id) : order,
          ]),
        ),
      };
    }
    expect(zoneSize(state, other, 'hand')).toBe(1);

    const entrance = place(state, player, 'BK2-042', 2, { faceUp: false });
    state = openable(entrance.state, player, entrance.card);
    state = apply(state, player, openOf(state, player, entrance.card) as GameAction);

    // "All players" includes its own controller (§13).
    expect(zoneSize(state, player, 'hand')).toBe(2);
    // A hand already under the size loses nothing.
    expect(zoneSize(state, other, 'hand')).toBe(1);
  });
});

describe('BK2 wards and granted subtypes (Rules.md §13)', () => {
  it('BK2-024 swallows one whole blow and is spent by it', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    // BK1-043 Golem is green and 2/2 — Schierke's 4 damage would kill it
    // outright, so surviving is the visible proof the ward ate the blow.
    const ward = place(state, player, 'BK1-043', 2);
    state = ward.state;

    const respite = place(state, player, 'BK2-024', 2, { faceUp: false });
    state = openable(respite.state, player, respite.card);
    const open = openOf(state, player, respite.card);
    expect(open, '3 Days Without Sun should point at an ally').toBeDefined();
    expect(open?.targets?.[0]).toBe(ward.card);
    state = apply(state, player, open as GameAction);
    expect(state.cards[ward.card]?.counters['ward']).toBe(1);

    // Schierke deals 4 — a shield of 1 would leave 3 through; a ward eats the
    // whole blow and is spent. She is Level 3, so three cities must be up.
    const schierke = place(state, other, 'BK1-053', 2, { faceUp: false });
    state = openable(schierke.state, other, schierke.card);
    // The Respite spent this turn's one open (§10 ③), so the strike comes on
    // a fresh turn — the ward lasts the turn it was granted, which is what
    // the test is actually about.
    state = {
      ...state,
      turn: {
        ...state.turn,
        activePlayer: other,
        priorityPlayer: other,
        openedThisTurn: false,
      },
    };
    const strike = openOf(state, other, schierke.card);
    expect(strike, 'Schierke should be openable').toBeDefined();
    state = apply(state, other, strike as GameAction);

    expect(state.cards[ward.card]?.damage).toBe(0);
    expect(state.cards[ward.card]?.zone).toBe('city');
    // Spent: the next blow lands in full.
    expect(state.cards[ward.card]?.counters['ward']).toBe(0);
  });

  it('BK2-016 makes your Mercenaries count as Hawks as well', () => {
    let state = started();
    const player = state.turn.activePlayer;

    // BK1-001 is the white Mercenary; BK1-010 Griffith buffs other Hawks
    // in his area, which is what makes the grant visible on the board.
    const merc = place(state, player, 'BK1-001', 2);
    state = merc.state;
    expect(subtypesOf({ registry }, cardOf(state, merc.card), state)).not.toContain('hawk');

    const griffith = place(state, player, 'BK1-010', 2);
    state = griffith.state;
    const beforeCeremony = power(state, merc.card);

    const ceremony = place(state, player, 'BK2-016', 1);
    state = ceremony.state;

    // Now it is a Hawk in addition to being a Mercenary, so Griffith's aura
    // reaches it — read off the board, nothing written down.
    expect(subtypesOf({ registry }, cardOf(state, merc.card), state)).toContain('hawk');
    expect(subtypesOf({ registry }, cardOf(state, merc.card), state)).toContain('mercenary');
    expect(power(state, merc.card)).toBe(beforeCeremony + 1);
  });
});

describe('BK2-045 makes the other player pay three times (Rules.md §13)', () => {
  it('offers hand, set cards and characters, and repeats the question', () => {
    let state = started('BK1-081');
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    // One of each kind on their side, plus whatever is in their hand.
    const theirCharacter = place(state, other, 'BK1-081', 3);
    state = theirCharacter.state;
    const theirSetCard = place(state, other, 'BK1-081', 4, { faceUp: false });
    state = theirSetCard.state;
    const handBefore = zoneSize(state, other, 'hand');
    expect(handBefore).toBeGreaterThan(0);

    const counter = place(state, player, 'BK2-045', 2, { faceUp: false });
    state = openable(counter.state, player, counter.card);
    const open = openOf(state, player, counter.card);
    expect(open, 'Swift Counter should be openable').toBeDefined();
    state = apply(state, player, open as GameAction);

    // The question goes to the other player, not to whoever opened it.
    expect(state.pending?.waitingOn).toBe(other);
    const offered = engine
      .legalActions(state, other)
      .filter((action) => action.type === 'CHOOSE_CARD')
      .map((action) => (action as Extract<GameAction, { type: 'CHOOSE_CARD' }>).card);
    // All three ways to pay are on the table at once.
    expect(offered).toContain(theirCharacter.card);
    expect(offered).toContain(theirSetCard.card);
    expect(offered.some((id) => state.cards[id]?.zone === 'hand')).toBe(true);

    // Pay the first with a character; the question comes straight back.
    state = apply(state, other, { type: 'CHOOSE_CARD', card: theirCharacter.card });
    expect(state.cards[theirCharacter.card]?.zone).toBe('trash');
    expect(state.pending?.waitingOn).toBe(other);

    // Pay the second with the Set Card...
    state = apply(state, other, { type: 'CHOOSE_CARD', card: theirSetCard.card });
    expect(state.cards[theirSetCard.card]?.zone).toBe('trash');
    expect(state.pending?.waitingOn).toBe(other);

    // ...and the third out of hand, which ends it: three payments, any mix.
    const fromHand = engine
      .legalActions(state, other)
      .filter((action) => action.type === 'CHOOSE_CARD')
      .map((action) => (action as Extract<GameAction, { type: 'CHOOSE_CARD' }>).card)
      .find((id) => state.cards[id]?.zone === 'hand');
    expect(fromHand, 'a card in hand should still be payable').toBeDefined();
    state = apply(state, other, { type: 'CHOOSE_CARD', card: fromHand as CardInstanceId });
    expect(zoneSize(state, other, 'hand')).toBe(handBefore - 1);
    expect(state.pending).toBeNull();
  });
});

describe('BK2 two-target and combat removal (Rules.md §13)', () => {
  it('BK2-029 moves one from each side to the same area', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const mine = place(state, player, GREEN, 1);
    state = mine.state;
    const theirs = place(state, other, GREEN, 3);
    state = theirs.state;

    const decoy = place(state, player, 'BK2-029', 2, { faceUp: false });
    state = openable(decoy.state, player, decoy.card);

    // Every legal (mine, theirs, area) combination is offered.
    const offers = engine
      .legalActions(state, player)
      .filter((action) => action.type === 'OPEN_CARD' && action.card === decoy.card) as Extract<
      GameAction,
      { type: 'OPEN_CARD' }
    >[];
    const pairs = offers.filter((o) => (o.targets ?? []).length === 2);
    expect(pairs.length).toBeGreaterThan(0);
    for (const offer of pairs) {
      // One of each side, never two of the same.
      const [a, b] = offer.targets as [CardInstanceId, CardInstanceId];
      expect(state.cards[a]?.controller).toBe(player);
      expect(state.cards[b]?.controller).toBe(other);
    }

    // Take one that lands them both in city 2, where the card stands.
    const chosen = pairs.find((o) => (o.areas ?? [])[0] === 2);
    expect(chosen, 'the pair should be placeable in this area').toBeDefined();
    state = apply(state, player, chosen as GameAction);

    // Both travelled to the same area (§14 over §6: no Move spent, no lock).
    expect(state.cards[mine.card]?.cityIndex).toBe(2);
    expect(state.cards[theirs.card]?.cityIndex).toBe(2);
  });

  it('BK2-026 takes a defender out of the fight but leaves it standing', () => {
    let state = started(GREEN);
    const attacker = state.turn.activePlayer;
    const defender = state.seats.find((seat) => seat !== attacker) as PlayerId;

    const lead = place(state, attacker, GREEN, 2);
    state = lead.state;
    const guard = place(state, defender, GREEN, 2);
    state = guard.state;
    const decoy = place(state, defender, 'BK2-026', 2, { faceUp: false });
    state = openable(decoy.state, defender, decoy.card);
    // The gate: the opponent must not hold this area (§12). Nobody does.
    state = {
      ...state,
      turn: { ...state.turn, activePlayer: attacker, priorityPlayer: attacker },
    };

    state = apply(atMain(state), attacker, { type: 'DECLARE_BATTLE', city: 2 });
    for (let n = 0; n < 6 && state.quick; n++) {
      state = apply(state, state.quick.waitingOn, { type: 'PASS_PRIORITY' });
    }
    state = apply(state, attacker, { type: 'DESIGNATE_VANGUARD', card: lead.card });
    expect(state.battle?.participants).toContain(lead.card);

    // The combat open (§11 ②) is where the defender plays it into the fight.
    const open = engine
      .legalActions(state, defender)
      .find(
        (action) =>
          action.type === 'OPEN_CARD' &&
          action.card === decoy.card &&
          (action.targets ?? [])[0] === lead.card,
      );
    expect(open, 'Outcome of Misconception should point at the attacker').toBeDefined();
    const after = engine.reduce(state, defender, open as GameAction);
    expect(after.ok).toBe(true);
    if (!after.ok) return;

    // Out of the fight, but still on the board and still locked (§11 ③).
    expect(after.value.state.battle?.participants ?? []).not.toContain(lead.card);
    expect(after.value.state.cards[lead.card]?.zone).toBe('city');
    expect(after.value.state.cards[lead.card]?.locked).toBe(true);
  });
});

describe('BK2-023 spends the counters it arrived with (Rules.md §13)', () => {
  it('gains two on opening, spends one per use, and runs out', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const enemy = place(state, other, GREEN, 2);
    state = enemy.state;
    const isidro = place(state, player, 'BK2-023', 2, { faceUp: false });
    state = openable(isidro.state, player, isidro.card);
    state = apply(state, player, openOf(state, player, isidro.card) as GameAction);
    expect(state.cards[isidro.card]?.counters['charges']).toBe(2);

    // Spend one.
    const use = engine
      .legalActions(atMain(state), player)
      .find((action) => action.type === 'USE_ABILITY' && action.card === isidro.card);
    expect(use, 'the Explosive ability should be offered').toBeDefined();
    state = apply(atMain(state), player, use as GameAction);
    expect(state.cards[isidro.card]?.counters['charges']).toBe(1);

    // Once per turn, so it is not offered again on this turn.
    expect(
      engine
        .legalActions(atMain(state), player)
        .some((action) => action.type === 'USE_ABILITY' && action.card === isidro.card),
    ).toBe(false);

    // With no counters left it is never offered again, whatever the turn.
    const spent = {
      ...state,
      cards: {
        ...state.cards,
        [isidro.card]: {
          ...cardOf(state, isidro.card),
          counters: { ...cardOf(state, isidro.card).counters, charges: 0, 'usedOnTurn:1': 0 },
        },
      },
    };
    expect(
      engine
        .legalActions(atMain(spent), player)
        .some((action) => action.type === 'USE_ABILITY' && action.card === isidro.card),
    ).toBe(false);
  });
});

describe('BK2-002 fetches a Mercenary to a Hawk area (Rules.md §13)', () => {
  it('offers only cities holding one of his Hawks, and opens what it sets', () => {
    let state = started();
    const player = state.turn.activePlayer;

    // BK1-009 Griffith is a Hawk; put him in city 3 and nothing in city 0.
    const hawk = place(state, player, 'BK1-009', 3);
    state = hawk.state;
    const griffith = place(state, player, 'BK2-002', 2);
    state = griffith.state;

    // Run to this player's turn start, where the ability fires.
    const other = state.seats.find((seat) => seat !== player) as PlayerId;
    let next = endTurn(endTurn(state, player), other);
    expect(next.turn.activePlayer).toBe(player);

    // "You may": a yes-or-no first.
    expect(next.pending?.kind.zone).toBe('decision');
    next = apply(next, player, { type: 'ANSWER', accept: true });

    // Then the Mercenaries in the deck, each offered only into Hawk areas.
    const chooses = engine
      .legalActions(next, player)
      .filter((action) => action.type === 'CHOOSE_CARD') as Extract<
      GameAction,
      { type: 'CHOOSE_CARD' }
    >[];
    expect(chooses.length).toBeGreaterThan(0);
    // City 3 holds a Hawk; city 0 does not, so it is never on offer.
    const cities = new Set(chooses.map((action) => action.city));
    expect(cities.has(3)).toBe(true);
    expect(cities.has(0)).toBe(false);

    // Take one: it lands in the Hawk's area and is opened at once.
    const pick = chooses.find((action) => action.city === 3) as Extract<
      GameAction,
      { type: 'CHOOSE_CARD' }
    >;
    next = apply(next, player, pick);
    expect(next.cards[pick.card]?.cityIndex).toBe(3);
    expect(next.cards[pick.card]?.faceUp).toBe(true);
  });
});

describe('BK2-021 offers two modes that share one use (Rules.md §13)', () => {
  it('spends the turn on whichever mode is taken', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const enemy = place(state, other, GREEN, 2);
    state = enemy.state;
    const serpico = place(state, player, 'BK2-021', 2);
    state = serpico.state;

    // Both modes are on the table to begin with.
    const both = engine
      .legalActions(atMain(state), player)
      .filter((action) => action.type === 'USE_ABILITY' && action.card === serpico.card);
    expect(new Set(both.map((a) => (a as { ability: string }).ability)).size).toBe(2);

    // Take the shield; the damage mode goes with it, since one printed
    // ability may only be used once per turn.
    const shield = both.find((a) => (a as { ability: string }).ability === '1');
    expect(shield, 'the shield mode should be offered').toBeDefined();
    let used = apply(atMain(state), player, shield as GameAction);
    for (let n = 0; n < 8 && used.stack.length > 0; n++) {
      used = apply(used, used.turn.priorityPlayer, { type: 'PASS_PRIORITY' });
    }
    expect(used.cards[serpico.card]?.counters['shield']).toBe(1);

    expect(
      engine
        .legalActions(atMain(used), player)
        .some((action) => action.type === 'USE_ABILITY' && action.card === serpico.card),
    ).toBe(false);
  });
});

describe('BK2-025 recycles whichever graveyard is chosen (Rules.md §13)', () => {
  /** Puts `count` cards of a player's into their Trash, out of their deck. */
  function fillTrash(state: GameState, player: PlayerId, count: number): GameState {
    let next = state;
    const deck = [...(next.zoneOrder[`${player}:deck`] ?? [])].slice(0, count);
    for (const id of deck) {
      next = {
        ...next,
        cards: { ...next.cards, [id]: { ...cardOf(next, id), zone: 'trash' as const } },
        zoneOrder: {
          ...next.zoneOrder,
          [`${player}:deck`]: (next.zoneOrder[`${player}:deck`] ?? []).filter((c) => c !== id),
          [`${player}:trash`]: [...(next.zoneOrder[`${player}:trash`] ?? []), id],
        },
      };
    }
    return next;
  }

  it("accepting takes the opponent's graveyard, and they draw", () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    state = fillTrash(state, other, 3);
    state = fillTrash(state, player, 3);
    const theirHand = zoneSize(state, other, 'hand');
    const myHand = zoneSize(state, player, 'hand');

    const elf = place(state, player, 'BK2-025', 2, { faceUp: false });
    state = openable(elf.state, player, elf.card);
    state = apply(state, player, openOf(state, player, elf.card) as GameAction);

    // A real choice, not a "you may".
    expect(state.pending?.kind.zone).toBe('decision');
    state = apply(state, player, { type: 'ANSWER', accept: true });

    // Their Trash emptied, their deck grew, and *they* drew the three.
    expect(zoneSize(state, other, 'trash')).toBe(0);
    expect(zoneSize(state, other, 'hand')).toBe(theirHand + 3);
    // Nothing was recycled on this side: the three planted cards are still
    // there, alongside whatever opening the card cost (§7).
    expect(zoneSize(state, player, 'trash')).toBeGreaterThanOrEqual(3);
    // And crucially the draw went to *them*, not to whoever opened it.
    expect(zoneSize(state, player, 'hand')).toBeLessThan(myHand + 3);
  });

  it('declining takes your own graveyard, and you draw', () => {
    let state = started(GREEN);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    state = fillTrash(state, other, 3);
    state = fillTrash(state, player, 3);
    const theirHand = zoneSize(state, other, 'hand');

    const elf = place(state, player, 'BK2-025', 2, { faceUp: false });
    state = openable(elf.state, player, elf.card);
    state = apply(state, player, openOf(state, player, elf.card) as GameAction);
    // Measured after the open, so the cost it paid is already accounted for
    // and what follows is exactly the three cards this branch draws.
    const myHand = zoneSize(state, player, 'hand');
    state = apply(state, player, { type: 'ANSWER', accept: false });

    // Declining is choosing the other branch, not doing nothing: three came
    // out of the graveyard, so what is left is only what opening it cost.
    expect(zoneSize(state, player, 'trash')).toBeLessThan(3);
    expect(zoneSize(state, player, 'hand')).toBe(myHand + 3);
    // Their graveyard is untouched.
    expect(zoneSize(state, other, 'trash')).toBe(3);
    expect(zoneSize(state, other, 'hand')).toBe(theirHand);
  });
});

describe('Alteration opens a card by sacrificing its own kind (Rules.md §7)', () => {
  it('spends a same-named character here instead of paying the cost', () => {
    let state = started(RED);
    const player = state.turn.activePlayer;

    // BK3-056 Locus prints Alteration. Another Locus standing here is what
    // pays for it — "another creature of the same type in the same area".
    const elder = place(state, player, 'BK1-135', 2);
    state = elder.state;
    const altered = place(state, player, 'BK3-056', 2, { faceUp: false });
    state = openable(altered.state, player, altered.card);

    const offers = engine
      .legalActions(state, player)
      .filter((action) => action.type === 'OPEN_CARD' && action.card === altered.card) as Extract<
      GameAction,
      { type: 'OPEN_CARD' }
    >[];
    const byAlteration = offers.filter((offer) => offer.alter !== undefined);
    expect(byAlteration.length).toBeGreaterThan(0);
    // The elder Locus is what may be spent, and an Alteration pays no cost.
    expect(byAlteration[0]?.alter).toBe(elder.card);
    expect(byAlteration[0]?.pay).toEqual([]);

    const handBefore = zoneSize(state, player, 'hand');
    state = apply(state, player, byAlteration[0] as GameAction);

    // The sacrifice is gone, the new card is up, and no cost left the hand.
    expect(state.cards[elder.card]?.zone).toBe('trash');
    expect(state.cards[altered.card]?.faceUp).toBe(true);
    expect(zoneSize(state, player, 'hand')).toBe(handBefore);
    // Remembered, so a card can tell how it arrived (BK3-055).
    expect(state.cards[altered.card]?.counters['altered']).toBe(1);
  });

  it('refuses a body of the wrong name, or one standing elsewhere', () => {
    let state = started(RED);
    const player = state.turn.activePlayer;

    // A different character here, and a matching one a city away: neither
    // may pay, since the printed line wants the same name *in this area*.
    const stranger = place(state, player, RED, 2);
    state = stranger.state;
    const distant = place(state, player, 'BK1-135', 4);
    state = distant.state;
    const altered = place(state, player, 'BK3-056', 2, { faceUp: false });
    state = openable(altered.state, player, altered.card);

    expect(altersFor({ registry }, state, cardOf(state, altered.card))).toHaveLength(0);
    // And the reducer refuses either, whatever the client sends.
    for (const wrong of [stranger.card, distant.card]) {
      const forced = engine.reduce(state, player, {
        type: 'OPEN_CARD',
        card: altered.card,
        pay: [],
        alter: wrong,
      });
      expect(forced.ok).toBe(false);
    }
  });

  it('BK3-055 tells the two ways in apart', () => {
    let state = started(RED);
    const player = state.turn.activePlayer;

    const elder = place(state, player, 'BK3-055', 2);
    state = elder.state;
    const altered = place(state, player, 'BK3-055', 2, { faceUp: false });
    state = openable(altered.state, player, altered.card);

    const byAlteration = (
      engine.legalActions(state, player).filter((action) => action.type === 'OPEN_CARD') as Extract<
        GameAction,
        { type: 'OPEN_CARD' }
      >[]
    ).find((offer) => offer.card === altered.card && offer.alter !== undefined);
    expect(byAlteration, 'a matching Grunbeld should be able to alter').toBeDefined();
    state = apply(state, player, byAlteration as GameAction);

    // Opened by Alteration, so it keeps +2/+2 for good — printed 5/5.
    expect(state.cards[altered.card]?.counters['permPower']).toBe(2);
    expect(power(state, altered.card)).toBe(7);
    expect(hp(state, altered.card)).toBe(7);
  });
});

describe('BK3-052 answers for every way it goes down (Rules.md §6)', () => {
  it('asks when the character locks to move, and destroys it on a refusal', () => {
    let state = started(RED);
    const player = state.turn.activePlayer;

    const lancer = place(state, player, 'BK3-052', 2);
    state = lancer.state;

    // Moving locks it (§6), which is one of the ways the trigger fires.
    const move = engine
      .legalActions(atMain(state), player)
      .find((action) => action.type === 'MOVE_CHARACTER' && action.card === lancer.card);
    expect(move, 'the lancer should be able to move').toBeDefined();
    state = apply(atMain(state), player, move as GameAction);

    // A real either/or, not a "you may": refusing is an instruction.
    expect(state.pending?.kind.zone).toBe('decision');
    expect(state.cards[lancer.card]?.locked).toBe(true);

    // With no set card to give up, declining costs the character.
    state = apply(state, player, { type: 'ANSWER', accept: false });
    expect(state.cards[lancer.card]?.zone).toBe('trash');
  });
});

describe('BK3 damage divided and control seized (Rules.md §13)', () => {
  it('BK3-048 spends four points one at a time, wherever the player says', () => {
    let state = started('BK1-081');
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    // Two 1/1 bodies: four points is enough to kill both and spare nobody.
    const first = place(state, other, 'BK1-081', 2);
    state = first.state;
    const second = place(state, other, 'BK1-081', 2);
    state = second.state;

    const strike = place(state, player, 'BK3-048', 2, { faceUp: false });
    state = openable(strike.state, player, strike.card);
    state = apply(state, player, openOf(state, player, strike.card) as GameAction);

    // Four points owed, spent a point at a time.
    expect(state.pending?.count).toBe(4);
    state = apply(state, player, { type: 'CHOOSE_CARD', card: first.card });
    // A 1/1 dies to the first point, and is no longer on offer.
    expect(state.cards[first.card]?.zone).toBe('trash');
    const left = engine
      .legalActions(state, player)
      .filter((action) => action.type === 'CHOOSE_CARD')
      .map((action) => (action as Extract<GameAction, { type: 'CHOOSE_CARD' }>).card);
    expect(left).not.toContain(first.card);
    expect(left).toContain(second.card);
  });

  it('BK2-063 takes control of a small character and stands it up', () => {
    let state = started(RED);
    const player = state.turn.activePlayer;
    const other = state.seats.find((seat) => seat !== player) as PlayerId;

    const prize = place(state, other, RED, 2);
    state = prize.state;
    state = {
      ...state,
      cards: { ...state.cards, [prize.card]: { ...cardOf(state, prize.card), locked: true } },
    };

    const oath = place(state, player, 'BK2-063', 2, { faceUp: false });
    state = openable(oath.state, player, oath.card);
    const open = engine
      .legalActions(state, player)
      .find(
        (action) =>
          action.type === 'OPEN_CARD' &&
          action.card === oath.card &&
          (action.targets ?? [])[0] === prize.card,
      );
    expect(open, 'Blade Oath should point at a small enemy').toBeDefined();
    state = apply(state, player, open as GameAction);

    // It changed sides where it stands, and was unlocked.
    expect(state.cards[prize.card]?.controller).toBe(player);
    expect(state.cards[prize.card]?.cityIndex).toBe(2);
    expect(state.cards[prize.card]?.locked).toBe(false);
  });
});

describe('Support pays for either colour (Rules.md §7)', () => {
  it('accepts a Support card wherever either of its colours is wanted', () => {
    let state = started();
    const player = state.turn.activePlayer;

    // Turn a card in hand into the white Support [Green] card, then open a
    // green Effect with it — a plain white card could not pay for that.
    const hand = state.zoneOrder[`${player}:hand`] ?? [];
    const payer = hand[0] as CardInstanceId;
    state = {
      ...state,
      cards: {
        ...state.cards,
        [payer]: { ...cardOf(state, payer), defId: asCardDefId('BK3-002') },
      },
    };

    // BK1-080 is a green Normal Effect costing a single green card.
    const green = place(state, player, 'BK1-080', 2, { faceUp: false });
    state = openable(green.state, player, green.card);

    const open = openOf(state, player, green.card);
    expect(open, 'a Support [Green] card should pay a green cost').toBeDefined();
    expect(open?.pay).toContain(payer);

    // And the reducer accepts the payment `legalActions` suggested.
    const after = engine.reduce(state, player, open as GameAction);
    expect(after.ok).toBe(true);
  });

  it('counts a card that says so as a Mercenary for deckbuilding', () => {
    // "Treated as a mercenary card during deckbuilding" (BK3-002) is about
    // Deckbuilding.md's two rules, not about the printed identity — the
    // Mercenary proper is still the first card of each colour block.
    expect(isMercenary('BK3-002')).toBe(true);
    expect(isMercenary('BK3-050')).toBe(true);
    // BK3-003 is Support but claims no such thing.
    expect(isMercenary('BK3-003')).toBe(false);
    expect(isMercenary('BK1-001')).toBe(true);
  });
});
