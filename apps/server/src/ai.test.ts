import {
  asCardInstanceId,
  catalogueRegistry,
  MERCENARIES,
  type CardInstance,
  type CardInstanceId,
  type GameAction,
  type GameState,
  type PlayerId,
} from '@berserk/engine';
import { describe, expect, it } from 'vitest';
import { AI_NAME, AI_PLAYER_ID, chooseAction, isAi } from './ai.js';

/**
 * Femto's judgement, tested directly. `chooseAction` is a pure function of the
 * position and the legal actions, so a position can just be built.
 */

const ME = AI_PLAYER_ID;
/** The other seat, so "the opponent" resolves to somebody. */
const THEM = 'human' as PlayerId;
const registry = catalogueRegistry();

/** Real card ids at a given printed Level, so the levels under test are real. */
function cardsAtLevel(level: number, count: number): string[] {
  const ids = registry
    .all()
    .filter((def) => def.level === level)
    .map((def) => def.id);
  expect(ids.length).toBeGreaterThanOrEqual(count);
  return ids.slice(0, count);
}

/**
 * A state holding a hand, an empty row of cities, and the seat and turn the
 * judgement reads.
 *
 * `seats` and `turn` are not decoration: which seat Femto holds decides
 * whether it is going second (Rules.md §9.2), and the turn number decides
 * whether the game is still early — both of which change what it sets. `THEM`
 * occupies the other seat so "the opponent" resolves to somebody.
 */
function withHand(
  defIds: readonly string[],
  handTarget = 7,
  turnNumber = 1,
  seats: readonly PlayerId[] = [ME, THEM],
): GameState {
  const cards: Record<string, CardInstance> = {};
  const order: CardInstanceId[] = [];

  defIds.forEach((defId, index) => {
    const instanceId = asCardInstanceId(`c${index}`);
    order.push(instanceId);
    cards[instanceId] = {
      instanceId,
      defId: defId as CardInstance['defId'],
      owner: ME,
      controller: ME,
      zone: 'hand',
      faceUp: false,
      locked: false,
      damage: 0,
      counters: {},
    };
  });

  return {
    cards,
    seats,
    turn: { turnNumber, activePlayer: ME, priorityPlayer: ME, phaseIndex: 3 },
    zoneOrder: { [`${ME}:hand`]: order },
    handTarget: { [ME]: handTarget },
    cities: [0, 1, 2, 3, 4].map((index) => ({
      index,
      name: `City ${index}`,
      royalCapital: false,
      faceUp: false,
      occupiedBy: null,
    })),
  } as unknown as GameState;
}

const handOf = (state: GameState): readonly CardInstanceId[] => state.zoneOrder[`${ME}:hand`] ?? [];

describe('the computer opponent', () => {
  it('answers to Femto', () => {
    expect(AI_NAME).toBe('Femto');
    expect(isAi(AI_PLAYER_ID)).toBe(true);
  });

  it('never concedes, even when that is all it could do', () => {
    // An opponent that gives up should let the human play the match out.
    const state = withHand([]);
    expect(chooseAction(state, [{ type: 'CONCEDE' }])).toBeNull();
    expect(chooseAction(state, [])).toBeNull();
  });

  describe('answering a Quick window', () => {
    /** A window waiting on Femto, with `count` Quicks on offer. */
    const asked = (state: GameState): GameState =>
      ({ ...state, quick: { waitingOn: ME, trigger: 'turnStart' } }) as unknown as GameState;

    it('takes the biggest Quick it is offered', () => {
      // Rules.md §13 — the window will not come round again, so a Quick it
      // declines is one it may never use. Same reasoning as its ordinary
      // opens, which also cannot be banked.
      const state = asked(withHand([cardsAtLevel(1, 1)[0]!, cardsAtLevel(4, 1)[0]!]));
      const cards = handOf(state);
      const chosen = chooseAction(state, [
        { type: 'PASS_PRIORITY' },
        { type: 'OPEN_CARD', card: cards[0]!, pay: [] },
        { type: 'OPEN_CARD', card: cards[1]!, pay: [] },
      ]);
      expect(chosen).toMatchObject({ type: 'OPEN_CARD', card: cards[1] });
    });

    it('passes when the window offers it nothing', () => {
      // It must answer *something*: a window stops the game until it is
      // closed, so a silent AI is a hung match.
      const state = asked(withHand([]));
      expect(chooseAction(state, [{ type: 'CONCEDE' }, { type: 'PASS_PRIORITY' }])).toEqual({
        type: 'PASS_PRIORITY',
      });
    });

    it('leaves a window meant for the other player alone', () => {
      const state = {
        ...withHand(cardsAtLevel(1, 2)),
        quick: { waitingOn: 'somebody-else', trigger: 'turnStart' },
      } as unknown as GameState;
      // Falls through to its ordinary judgement rather than answering for
      // somebody else — `chooseAction` is called for Femto's seat only.
      expect(chooseAction(state, [{ type: 'END_PHASE' }])).toEqual({ type: 'END_PHASE' });
    });
  });

  describe('answering an effect that stopped to ask', () => {
    /** A choice of `zone` waiting on Femto. Rules.md §13. */
    const asking = (state: GameState, zone: 'hand' | 'deck'): GameState =>
      ({
        ...state,
        pending: {
          waitingOn: ME,
          source: 'c0',
          text: 'a printed line',
          count: 1,
          kind:
            zone === 'hand' ? { zone, action: 'discard' } : { zone, action: 'toHand', named: null },
        },
      }) as unknown as GameState;

    const picks = (cards: readonly CardInstanceId[]): GameAction[] =>
      cards.map((card) => ({ type: 'CHOOSE_CARD' as const, card }));

    it('pitches the card it could open latest', () => {
      // The same judgement as the hand limit: a card it cannot open for
      // several turns is the one it misses least.
      const state = asking(withHand([cardsAtLevel(1, 1)[0]!, cardsAtLevel(4, 1)[0]!]), 'hand');
      const cards = handOf(state);
      expect(chooseAction(state, [{ type: 'CONCEDE' }, ...picks(cards)])).toEqual({
        type: 'CHOOSE_CARD',
        card: cards[1],
      });
    });

    it('searches out the card it could actually use', () => {
      // The opposite end of the same ordering. A search is a free pick, so it
      // takes something it can open now rather than a card it must sit on.
      const state = asking(withHand([cardsAtLevel(1, 1)[0]!, cardsAtLevel(4, 1)[0]!]), 'deck');
      const cards = handOf(state);
      expect(chooseAction(state, [{ type: 'CONCEDE' }, ...picks(cards)])).toEqual({
        type: 'CHOOSE_CARD',
        card: cards[0],
      });
    });

    it('answers the question before anything else it could do', () => {
      // A pending choice outranks every other move: until it is answered
      // nothing else is legal, so reaching past it would hang the match.
      const state = asking(withHand(cardsAtLevel(1, 2)), 'hand');
      const cards = handOf(state);
      const chosen = chooseAction(state, [
        { type: 'END_PHASE' },
        { type: 'SET_CARD', card: cards[0]!, city: 2 },
        ...picks(cards),
      ]);
      expect(chosen).toMatchObject({ type: 'CHOOSE_CARD' });
    });

    it('leaves a question meant for the other player alone', () => {
      const state = {
        ...withHand(cardsAtLevel(1, 2)),
        pending: {
          waitingOn: 'somebody-else',
          source: 'c0',
          text: 'a printed line',
          count: 1,
          kind: { zone: 'hand', action: 'discard' },
        },
      } as unknown as GameState;
      expect(chooseAction(state, [{ type: 'END_PHASE' }])).toEqual({ type: 'END_PHASE' });
    });
  });

  describe('settling its opening hand', () => {
    const decide = (state: GameState): GameAction | null =>
      chooseAction(state, [{ type: 'CONCEDE' }, { type: 'KEEP_HAND' }, { type: 'MULLIGAN' }]);

    it('keeps a hand it could actually open from', () => {
      // Three cards openable while City Level is still low. Rules.md §7.
      const state = withHand([...cardsAtLevel(1, 3), ...cardsAtLevel(4, 4)]);
      expect(decide(state)).toEqual({ type: 'KEEP_HAND' });
    });

    it('mulligans a hand of nothing it could open', () => {
      const state = withHand(cardsAtLevel(4, 7));
      expect(decide(state)).toEqual({ type: 'MULLIGAN' });
    });

    it('stops mulliganing before the hand gets too small to pay with', () => {
      // The same unopenable hand, several mulligans deep. Rules.md §7 pays
      // costs out of hand, so trading it away forever is its own defeat.
      const state = withHand(cardsAtLevel(4, 7), 4);
      expect(decide(state)).toEqual({ type: 'KEEP_HAND' });
    });

    it('keeps when mulliganing is not on offer', () => {
      const state = withHand(cardsAtLevel(4, 7));
      expect(chooseAction(state, [{ type: 'KEEP_HAND' }])).toEqual({ type: 'KEEP_HAND' });
    });
  });

  describe('paying for a keep', () => {
    it('gives back the card it could open latest', () => {
      const state = withHand([cardsAtLevel(0, 1)[0]!, cardsAtLevel(4, 1)[0]!]);
      const [first, second] = handOf(state);

      const actions: GameAction[] = [
        { type: 'BOTTOM_CARD', card: first! },
        { type: 'BOTTOM_CARD', card: second! },
      ];
      expect(chooseAction(state, actions)).toEqual({ type: 'BOTTOM_CARD', card: second });
    });

    it('gives back a card it cannot read a Level for, first of all', () => {
      // Every printed card now has a Level, so this is the defensive path
      // rather than a real one: a card the registry has never heard of cannot
      // be opened, which makes it the least useful thing in a hand.
      expect(registry.all().every((def) => def.level !== null)).toBe(true);

      const state = withHand([cardsAtLevel(4, 1)[0]!, 'BK9-999']);
      const [first, second] = handOf(state);
      const actions: GameAction[] = [
        { type: 'BOTTOM_CARD', card: first! },
        { type: 'BOTTOM_CARD', card: second! },
      ];
      expect(chooseAction(state, actions)).toEqual({ type: 'BOTTOM_CARD', card: second });
    });
  });

  it('discards its least openable card at the hand limit', () => {
    // Rules.md §10 ⑤ — the turn cannot end while holding more than seven.
    const state = withHand([cardsAtLevel(1, 1)[0]!, cardsAtLevel(3, 1)[0]!]);
    const [first, second] = handOf(state);
    const actions: GameAction[] = [
      { type: 'CONCEDE' },
      { type: 'DISCARD_CARD', card: first! },
      { type: 'DISCARD_CARD', card: second! },
    ];
    expect(chooseAction(state, actions)).toEqual({ type: 'DISCARD_CARD', card: second });
  });

  describe('opening a card', () => {
    const openable = (cards: readonly CardInstanceId[]): GameAction[] =>
      cards.map((card) => ({ type: 'OPEN_CARD' as const, card, pay: [] }));

    it('takes the biggest open available, because there is only one a turn', () => {
      // Rules.md §10 ③ — the turn's open cannot be banked, so a cheap card
      // opened now costs the chance to open the expensive one.
      const state = withHand([cardsAtLevel(1, 1)[0]!, cardsAtLevel(4, 1)[0]!]);
      const cards = handOf(state);
      const chosen = chooseAction(state, [{ type: 'END_PHASE' }, ...openable(cards)]);
      expect(chosen).toMatchObject({ type: 'OPEN_CARD', card: cards[1] });
    });

    it('breaks a tie by paying with fewer cards', () => {
      // Rules.md §7 pays costs out of hand, so cards spent are cards gone.
      const [a, b] = cardsAtLevel(2, 2);
      const state = withHand([a!, b!]);
      const [first, second] = handOf(state);
      const chosen = chooseAction(state, [
        { type: 'OPEN_CARD', card: first!, pay: ['x', 'y'] as never },
        { type: 'OPEN_CARD', card: second!, pay: ['x'] as never },
      ]);
      expect(chosen).toMatchObject({ type: 'OPEN_CARD', card: second });
    });

    it('opens rather than setting, when it could do either', () => {
      const state = withHand(cardsAtLevel(2, 1));
      const cards = handOf(state);
      const chosen = chooseAction(state, [
        { type: 'SET_CARD', card: cards[0]!, city: 2 },
        ...openable(cards),
      ]);
      expect(chosen).toMatchObject({ type: 'OPEN_CARD' });
    });
  });

  describe('setting a card', () => {
    const everywhere = (cards: readonly CardInstanceId[]): GameAction[] =>
      cards.flatMap((card) =>
        [0, 1, 2, 3, 4].map((city) => ({ type: 'SET_CARD' as const, card, city })),
      );

    it('sets the card it could open soonest', () => {
      const state = withHand([cardsAtLevel(3, 1)[0]!, cardsAtLevel(0, 1)[0]!]);
      const cards = handOf(state);
      const chosen = chooseAction(state, [
        { type: 'CONCEDE' },
        { type: 'END_PHASE' },
        ...everywhere(cards),
      ]);
      expect(chosen).toMatchObject({ type: 'SET_CARD', card: cards[1] });
    });

    it('opens on the middle city, which reaches most of the row', () => {
      const state = withHand(cardsAtLevel(1, 1));
      const chosen = chooseAction(state, everywhere(handOf(state)));
      expect(chosen).toMatchObject({ type: 'SET_CARD', city: 2 });
    });

    it('spreads out rather than stacking one city', () => {
      // The Royal Capital is face-down and could be any of the five, so
      // presence everywhere is what gives Femto a say in the one that counts.
      const state = withHand(cardsAtLevel(1, 1));
      const crowded = {
        ...state,
        cards: {
          ...state.cards,
          already: {
            instanceId: asCardInstanceId('already'),
            defId: cardsAtLevel(1, 1)[0]! as CardInstance['defId'],
            owner: ME,
            controller: ME,
            zone: 'city',
            cityIndex: 2,
            faceUp: false,
            locked: false,
            damage: 0,
            counters: {},
          },
        },
      } as unknown as GameState;

      const chosen = chooseAction(crowded, everywhere(handOf(state)));
      expect(chosen).toMatchObject({ type: 'SET_CARD' });
      // The middle is taken, so it takes the next-most central empty city.
      expect((chosen as Extract<GameAction, { type: 'SET_CARD' }>).city).not.toBe(2);
    });

    it('going second, sets a Level 1 over a Level 0 on the first turn', () => {
      // Rules.md §10 ② — the player going second reaches their first Open
      // step after the opener has had a turn, so City Level has usually
      // already risen to 1. A Level 1 card is the bigger body for the same
      // one open; the Mercenary would have been openable either way.
      const mercenary = MERCENARIES[0]!.id;
      const state = withHand([mercenary, cardsAtLevel(1, 1)[0]!], 7, 1, [THEM, ME]);
      const cards = handOf(state);
      const chosen = chooseAction(state, everywhere(cards));
      expect(chosen).toMatchObject({ type: 'SET_CARD', card: cards[1] });
    });

    it('going first, still sets the card it can open soonest', () => {
      // The mirror: going first there is no raised Level to bank on, so the
      // Level 0 body is the one that can actually be opened.
      const mercenary = MERCENARIES[0]!.id;
      const state = withHand([mercenary, cardsAtLevel(1, 1)[0]!], 7, 1, [ME, THEM]);
      const cards = handOf(state);
      const chosen = chooseAction(state, everywhere(cards));
      expect(chosen).toMatchObject({ type: 'SET_CARD', card: cards[0] });
    });

    it('prefers a Mercenary early, over another card of the same Level', () => {
      // Level 0 either way, so nothing separates them on speed. The Mercenary
      // is the card a deck carries ten of, which makes it the one to spend on
      // claiming an area while areas are still there for the claiming.
      const mercenary = MERCENARIES[0]!.id;
      const other = registry.all().find((def) => def.level === 0 && def.name !== 'Mercenary')?.id;
      if (!other) return; // no such card in the set; nothing to compare
      const state = withHand([other, mercenary], 7, 1, [ME, THEM]);
      const cards = handOf(state);
      const chosen = chooseAction(state, everywhere(cards));
      expect(chosen).toMatchObject({ type: 'SET_CARD', card: cards[1] });
    });

    it('sets into the Royal Capital once it is known, crowded or not', () => {
      // Rules.md §1 — the Capital is the one area the game cannot be won
      // without, so it outranks spreading the moment it is face up.
      const state = withHand(cardsAtLevel(1, 1));
      const known = {
        ...state,
        cities: state.cities.map((city, index) =>
          index === 4 ? { ...city, faceUp: true, royalCapital: true } : city,
        ),
      } as unknown as GameState;
      const chosen = chooseAction(known, everywhere(handOf(state)));
      expect(chosen).toMatchObject({ type: 'SET_CARD', city: 4 });
    });

    it('avoids an area the opponent is standing in', () => {
      // A card set where they are has to win a battle to matter; one set
      // where they are not can simply take the area.
      const state = withHand(cardsAtLevel(1, 1));
      const contested = {
        ...state,
        cards: {
          ...state.cards,
          theirs: {
            instanceId: asCardInstanceId('theirs'),
            defId: cardsAtLevel(1, 1)[0]! as CardInstance['defId'],
            owner: THEM,
            controller: THEM,
            zone: 'city',
            cityIndex: 2,
            faceUp: true,
            locked: false,
            damage: 0,
            counters: {},
          },
        },
      } as unknown as GameState;

      const chosen = chooseAction(contested, everywhere(handOf(state)));
      expect((chosen as Extract<GameAction, { type: 'SET_CARD' }>).city).not.toBe(2);
    });

    it('ends the phase when it has nothing to set', () => {
      const state = withHand([]);
      expect(chooseAction(state, [{ type: 'CONCEDE' }, { type: 'END_PHASE' }])).toEqual({
        type: 'END_PHASE',
      });
    });
  });

  describe('picking a fight', () => {
    /** A board with `mine`/`theirs` face-up characters standing in a city. */
    const board = (
      city: number,
      mine: number,
      theirs: number,
      options: { capital?: boolean; occupiedBy?: PlayerId } = {},
    ): GameState => {
      const state = withHand([], 7, 4);
      const cards: Record<string, unknown> = { ...state.cards };
      const put = (owner: PlayerId, count: number, tag: string): void => {
        for (let i = 0; i < count; i++) {
          const id = `${tag}${i}`;
          cards[id] = {
            instanceId: asCardInstanceId(id),
            // A Level 1 character, so each body carries real Power.
            defId: cardsAtLevel(1, 1)[0]! as CardInstance['defId'],
            owner,
            controller: owner,
            zone: 'city',
            cityIndex: city,
            faceUp: true,
            locked: false,
            damage: 0,
            counters: {},
          };
        }
      };
      put(ME, mine, 'm');
      put(THEM, theirs, 't');

      return {
        ...state,
        cards,
        cities: state.cities.map((c, index) =>
          index === city
            ? {
                ...c,
                faceUp: true,
                royalCapital: options.capital ?? false,
                occupiedBy: options.occupiedBy ?? null,
              }
            : c,
        ),
      } as unknown as GameState;
    };

    const attack = (city: number): GameAction => ({ type: 'DECLARE_BATTLE', city });

    it('attacks an area nobody is defending', () => {
      // Rules.md §12 reads the result off who was committed, so an attacker
      // who turns up against nobody takes the area outright. Femto used to
      // need a strictly bigger stack, which an empty area never produced.
      const state = board(2, 1, 0);
      expect(chooseAction(state, [{ type: 'END_PHASE' }, attack(2)])).toMatchObject({
        type: 'DECLARE_BATTLE',
        city: 2,
      });
    });

    it('does not attack into a fight it would lose', () => {
      const state = board(2, 1, 3);
      expect(chooseAction(state, [{ type: 'END_PHASE' }, attack(2)])).toEqual({
        type: 'END_PHASE',
      });
    });

    it('trades evenly into the Royal Capital, but nowhere else', () => {
      // §1 — the Capital is the area the game cannot be won without, so an
      // even trade there is worth making and an even trade elsewhere is not.
      const capital = board(2, 2, 2, { capital: true });
      expect(chooseAction(capital, [{ type: 'END_PHASE' }, attack(2)])).toMatchObject({
        type: 'DECLARE_BATTLE',
      });

      const ordinary = board(2, 2, 2);
      expect(chooseAction(ordinary, [{ type: 'END_PHASE' }, attack(2)])).toEqual({
        type: 'END_PHASE',
      });
    });

    it('goes for the Capital ahead of an easier fight elsewhere', () => {
      const state = {
        ...board(2, 3, 0),
        cities: board(2, 3, 0).cities.map((c, index) =>
          index === 4 ? { ...c, faceUp: true, royalCapital: true } : c,
        ),
      } as unknown as GameState;
      // City 4 is the Capital and empty; city 2 is a bigger win on paper.
      const chosen = chooseAction(state, [{ type: 'END_PHASE' }, attack(2), attack(4)]);
      expect(chosen).toMatchObject({ type: 'DECLARE_BATTLE', city: 4 });
    });

    it('takes the free combat open rather than passing it up', () => {
      // §11 ② — the combat open does not spend the turn's one open (§10 ③),
      // so declining it gains nothing. §11 ③ keeps committing separate, so
      // the card can come down and stay out of a fight it would lose.
      const state = {
        ...board(2, 1, 3),
        battle: {
          city: 2,
          step: 'opens',
          waitingOn: ME,
          attacker: THEM,
          defender: ME,
          participants: [],
          opened: [],
          passes: 0,
          vanguard: null,
          assigning: [],
        },
      } as unknown as GameState;

      const chosen = chooseAction(state, [
        { type: 'BATTLE_PASS' },
        { type: 'OPEN_CARD', card: asCardInstanceId('x'), pay: [] },
      ]);
      expect(chosen).toMatchObject({ type: 'OPEN_CARD' });
    });

    it('passes the combat open when there is nothing to open', () => {
      const state = {
        ...board(2, 1, 3),
        battle: {
          city: 2,
          step: 'opens',
          waitingOn: ME,
          attacker: THEM,
          defender: ME,
          participants: [],
          opened: [],
          passes: 0,
          vanguard: null,
          assigning: [],
        },
      } as unknown as GameState;

      expect(chooseAction(state, [{ type: 'BATTLE_PASS' }])).toEqual({ type: 'BATTLE_PASS' });
    });
  });
});
