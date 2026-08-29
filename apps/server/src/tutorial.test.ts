import { catalogueRegistry, createEngine } from '@berserk/engine';
import { describe, expect, it } from 'vitest';
import { AI_PLAYER_ID } from './ai.js';
import { asTutorialPlayer, tutorialDeckLegal, tutorialSeed, tutorialCards } from './tutorial.js';

/**
 * The guided game deals the same way every time, and deals something worth
 * teaching from. DesignNotes "Tutorial".
 */
describe('the tutorial', () => {
  it('plays a legal deck', () => {
    expect(tutorialDeckLegal()).toBe(true);
    expect(tutorialCards()).toHaveLength(45);
  });

  it('finds a seed that seats the human first with Mercenaries in hand', () => {
    const engine = createEngine(catalogueRegistry());
    const human = asTutorialPlayer('account-1');
    const seed = tutorialSeed(engine, human, AI_PLAYER_ID);
    expect(seed).toBeGreaterThan(0);
    // The same answer twice: the search is deterministic and cached.
    expect(tutorialSeed(engine, human, AI_PLAYER_ID)).toBe(seed);

    const cards = tutorialCards();
    const state = engine.createMatch({
      matchId: 'tutorial' as never,
      seed,
      decks: [
        { playerId: human, name: 'You', cards },
        { playerId: AI_PLAYER_ID, name: 'Femto', cards },
      ],
    });
    expect(state.seats[0]).toBe(human);
    const hand = (state.zoneOrder[`${human}:hand`] ?? []).map((id) => state.cards[id]?.defId);
    expect(hand.filter((id) => id === 'BK1-001').length).toBeGreaterThanOrEqual(2);
  });
});
