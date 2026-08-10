import {
  asCardInstanceId,
  catalogueRegistry,
  type CardInstance,
  type CardInstanceId,
  type GameAction,
  type GameState,
} from '@berserk/engine';
import { describe, expect, it } from 'vitest';
import { AI_NAME, AI_PLAYER_ID, chooseAction, isAi } from './ai.js';

/**
 * Femto's judgement, tested directly. `chooseAction` is a pure function of the
 * position and the legal actions, so a position can just be built.
 */

const ME = AI_PLAYER_ID;
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

/** A state holding just a hand and an empty row, which is all these read. */
function withHand(defIds: readonly string[], handTarget = 7): GameState {
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

    it('ends the phase when it has nothing to set', () => {
      const state = withHand([]);
      expect(chooseAction(state, [{ type: 'CONCEDE' }, { type: 'END_PHASE' }])).toEqual({
        type: 'END_PHASE',
      });
    });
  });
});
