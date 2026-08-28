import { asCardInstanceId, asPlayerId, type GameEvent } from '@berserk/engine';
import { describe, expect, it } from 'vitest';
import { BEAT_MS, planBeats, presentationMs } from './presentation.js';

/**
 * How a batch is cut into beats. The client plays these in order and the
 * server waits for their sum, so what matters here is the *order* and that
 * nothing the player should see is dropped or doubled.
 */

const ME = asPlayerId('me');
const THEM = asPlayerId('them');
const a = asCardInstanceId('a');
const b = asCardInstanceId('b');
const c = asCardInstanceId('c');

const kinds = (events: readonly GameEvent[], viewer = ME): string[] =>
  planBeats(events, viewer).map((beat) => beat.kind);

describe('planBeats', () => {
  it('announces a turn with the phases it ran through, and nothing before it settles', () => {
    const events: GameEvent[] = [
      { type: 'TURN_STARTED', player: THEM, turnNumber: 2 },
      { type: 'PHASE_CHANGED', phaseId: 'refresh', player: THEM },
      { type: 'CARDS_UNLOCKED', player: THEM, count: 2 },
      { type: 'PHASE_CHANGED', phaseId: 'draw', player: THEM },
      { type: 'CARD_DRAWN', player: THEM, card: a },
      { type: 'PHASE_CHANGED', phaseId: 'open', player: THEM },
    ];
    const beats = planBeats(events, ME);
    // The banner covers the cards sliding under it: no settle beat first.
    expect(beats.map((beat) => beat.kind)).toEqual(['turn']);
    const turn = beats[0];
    expect(turn?.kind === 'turn' && turn.phases).toEqual(['refresh', 'draw', 'open']);
  });

  it('captions your own phases and stays quiet about theirs', () => {
    const mine: GameEvent[] = [{ type: 'PHASE_CHANGED', phaseId: 'main', player: ME }];
    expect(kinds(mine)).toEqual(['phase']);
    const theirs: GameEvent[] = [{ type: 'PHASE_CHANGED', phaseId: 'main', player: THEM }];
    expect(kinds(theirs)).toEqual([]);
  });

  it('shows an open once, with the ability it fired', () => {
    const events: GameEvent[] = [
      { type: 'CARD_OPENED', player: THEM, card: a, city: 2 },
      { type: 'ABILITY_RESOLVED', player: THEM, card: a, text: 'Draw 2 cards.' },
      { type: 'CARD_DRAWN', player: THEM, card: b },
      { type: 'CARD_DRAWN', player: THEM, card: c },
    ];
    const beats = planBeats(events, ME);
    expect(beats.map((beat) => beat.kind)).toEqual(['settle', 'open']);
    const open = beats[1];
    expect(open?.kind === 'open' && open.ability).toBe('Draw 2 cards.');
    expect(open?.ms).toBe(BEAT_MS.OPEN_WITH_ABILITY);
  });

  it('marks an ability that found nothing to do', () => {
    const events: GameEvent[] = [
      { type: 'CARD_OPENED', player: ME, card: a, city: 2 },
      { type: 'ABILITY_RESOLVED', player: ME, card: a, text: 'Deal 4 damage to each enemy here.' },
      { type: 'ABILITY_FIZZLED', player: ME, card: a, text: 'Deal 4 damage to each enemy here.' },
    ];
    const open = planBeats(events, ME).find((beat) => beat.kind === 'open');
    expect(open?.kind === 'open' && open.fizzled).toBe(true);
  });

  it('plays an exchange as bands, each death behind the blow that caused it', () => {
    const events: GameEvent[] = [
      { type: 'DAMAGE_DEALT', source: a, target: b, amount: 3, combat: true },
      { type: 'DAMAGE_DEALT', source: b, target: a, amount: 1, combat: true },
      { type: 'CHARACTER_DESTROYED', card: b },
      { type: 'DAMAGE_DEALT', source: c, target: a, amount: 2, combat: true },
      { type: 'CHARACTER_DESTROYED', card: a },
      { type: 'BATTLE_ENDED', city: 3, result: 'occupation', occupier: THEM },
      { type: 'CITY_OCCUPIED', city: 3, player: THEM },
      { type: 'CARD_DRAWN', player: THEM, card: c },
    ];
    const beats = planBeats(events, ME);
    expect(beats.map((beat) => beat.kind)).toEqual(['settle', 'strike', 'strike', 'cityTaken']);
    const [, first, second] = beats;
    expect(first?.kind === 'strike' && first.hits.length).toBe(2);
    expect(first?.kind === 'strike' && first.deaths).toEqual([b]);
    expect(first?.kind === 'strike' && first.city).toBe(3);
    expect(second?.kind === 'strike' && second.deaths).toEqual([a]);
    // A band with a death in it holds for the fade; one without is quicker.
    expect(first?.ms).toBe(BEAT_MS.DEATH_AFTER + BEAT_MS.DEATH_FADE);
  });

  it('wakes the city when the vanguard steps forward, after the lock has settled', () => {
    const events: GameEvent[] = [
      { type: 'VANGUARD_DESIGNATED', card: a },
      { type: 'CITY_FLIPPED', city: 2, faceUp: true, cityLevel: 1 },
      { type: 'BATTLE_STEP', step: 'opens', waitingOn: THEM },
    ];
    expect(kinds(events)).toEqual(['settle', 'cityWakes']);
  });

  it('does not announce a city falling vacant', () => {
    const events: GameEvent[] = [{ type: 'CITY_OCCUPIED', city: 1, player: null }];
    expect(kinds(events)).toEqual([]);
  });

  it('keeps the order the engine resolved things in', () => {
    // An ability at the end of one turn, then the next turn's banner, then an
    // ability at its start. Hoisting the banner would put the first ability
    // after a turn it belongs before.
    const events: GameEvent[] = [
      { type: 'ABILITY_RESOLVED', player: ME, card: a, text: 'Return this card to hand.' },
      { type: 'CARD_RETURNED', player: ME, card: a },
      { type: 'TURN_STARTED', player: THEM, turnNumber: 3 },
      { type: 'PHASE_CHANGED', phaseId: 'refresh', player: THEM },
      { type: 'ABILITY_RESOLVED', player: THEM, card: b, text: 'Draw a card.' },
      { type: 'CARD_DRAWN', player: THEM, card: c },
    ];
    expect(kinds(events)).toEqual(['settle', 'ability', 'turn', 'ability']);
  });

  it('charges each board change to the beat that explains it', () => {
    const events: GameEvent[] = [
      // Paid before the card is held up: the hand loses these at once.
      { type: 'CARD_TRASHED', player: ME, card: c },
      { type: 'CARD_OPENED', player: ME, card: a, city: 2 },
      { type: 'DAMAGE_DEALT', source: a, target: b, amount: 4, combat: false },
      { type: 'CHARACTER_DESTROYED', card: b },
      { type: 'CITY_OCCUPIED', city: 2, player: ME },
      { type: 'CARD_DRAWN', player: ME, card: c },
    ];
    const beats = planBeats(events, ME);
    expect(beats.map((beat) => beat.kind)).toEqual(['settle', 'open', 'strike', 'cityTaken']);
    const [settle, open, strike, taken] = beats;
    expect(settle?.reveals.cards).toEqual([]);
    expect(open?.reveals.cards).toEqual([a]);
    expect(strike?.reveals.cards).toEqual([b]);
    expect(taken?.reveals.cities).toEqual([2]);
    expect(taken?.reveals.cards).toEqual([c]);
  });

  it('adds up to the time the screen is busy', () => {
    const events: GameEvent[] = [{ type: 'CARD_SET', player: THEM, card: a, city: 0 }];
    expect(presentationMs(events, ME)).toBe(BEAT_MS.SETTLE);
    expect(presentationMs([], ME)).toBe(0);
  });
});
