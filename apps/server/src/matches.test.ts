import { MERCENARIES, asMatchId, asPlayerId, cardsInSet, type DeckEntry } from '@berserk/engine';
import { describe, expect, it } from 'vitest';
import { MatchManager } from './matches.js';

/** A legal 45-card deck: 10 mercenaries plus 35 ordinary cards. */
function legalDeck(name: string): { id: string; name: string; cards: DeckEntry[] } {
  const cards: DeckEntry[] = [{ cardId: MERCENARIES[0]!.id, quantity: 10 }];
  let remaining = 35;
  for (const card of cardsInSet('BK1').filter((c) => !c.mercenary)) {
    if (remaining === 0) break;
    const quantity = Math.min(3, remaining);
    cards.push({ cardId: card.id, quantity });
    remaining -= quantity;
  }
  return { id: `deck-${name}`, name, cards };
}

const ALICE = asPlayerId('alice');
const BOB = asPlayerId('bob');
const CAROL = asPlayerId('carol');

function seatedMatch() {
  const manager = new MatchManager();
  const match = manager.create();
  manager.join(match.id, ALICE, 'Alice');
  manager.join(match.id, BOB, 'Bob');
  return { manager, match };
}

/** Seats both players, has them choose decks, and starts the match. */
function dealtMatch() {
  const seated = seatedMatch();
  seated.manager.chooseDeck(seated.match.id, ALICE, legalDeck('alice'));
  seated.manager.chooseDeck(seated.match.id, BOB, legalDeck('bob'));
  seated.manager.startMatch(seated.match.id, ALICE);
  return seated;
}

/** Settles both mulligans so the match reaches the first turn. */
function startedMatch() {
  const seated = dealtMatch();
  seated.manager.submitAction(seated.match.id, ALICE, { type: 'KEEP_HAND' });
  seated.manager.submitAction(seated.match.id, BOB, { type: 'KEEP_HAND' });
  return seated;
}

describe('MatchManager', () => {
  it('deals only once both players have chosen a deck', () => {
    const manager = new MatchManager();
    const match = manager.create();

    manager.join(match.id, ALICE, 'Alice');
    manager.join(match.id, BOB, 'Bob');
    // Seating is not enough: DesignNotes 4 has both players pick a deck first.
    expect(match.state).toBeNull();

    manager.chooseDeck(match.id, ALICE, legalDeck('alice'));
    expect(match.state).toBeNull();

    manager.chooseDeck(match.id, BOB, legalDeck('bob'));
    // Both decks are in, and still nothing deals: DesignNotes 3 has one of
    // the players press the button.
    expect(match.state).toBeNull();
    expect(manager.readyToStart(match)).toBe(true);
    expect(manager.startMatch(match.id, CAROL).ok).toBe(false);

    expect(manager.startMatch(match.id, BOB).ok).toBe(true);
    // Rules.md §9 — the match opens in setup while both players mulligan.
    expect(match.state?.status.kind).toBe('setup');
    expect(manager.startMatch(match.id, ALICE).ok).toBe(false);
  });

  it('will not start before both decks are chosen', () => {
    const { manager, match } = seatedMatch();
    manager.chooseDeck(match.id, ALICE, legalDeck('alice'));
    const early = manager.startMatch(match.id, ALICE);
    expect(early.ok).toBe(false);
    expect(match.state).toBeNull();
  });

  it('keeps a private room to those who know the word', () => {
    // DesignNotes 2 — a room password.
    const manager = new MatchManager();
    const match = manager.create('griffith');
    expect(manager.join(match.id, ALICE, 'Alice', null, 'griffith').ok).toBe(true);

    const wrong = manager.join(match.id, BOB, 'Bob', null, 'guts');
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.code).toBe('WRONG_PASSWORD');
    expect(manager.join(match.id, BOB, 'Bob', null, null).ok).toBe(false);
    expect(manager.join(match.id, BOB, 'Bob', null, 'griffith').ok).toBe(true);

    // A seat already held needs no password: reconnecting must not ask.
    expect(manager.join(match.id, ALICE, 'Alice').ok).toBe(true);
    // And a private room is never handed out as "an open match".
    expect(manager.findOrCreateOpen().id).not.toBe(match.id);
  });

  it('refuses an illegal deck', () => {
    const { manager, match } = seatedMatch();
    const result = manager.chooseDeck(match.id, ALICE, {
      id: 'short',
      name: 'Too small',
      cards: [{ cardId: MERCENARIES[0]!.id, quantity: 10 }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/exactly 45/);
    expect(match.state).toBeNull();
  });

  it('refuses a deck from someone not seated', () => {
    const { manager, match } = seatedMatch();
    expect(manager.chooseDeck(match.id, CAROL, legalDeck('carol')).ok).toBe(false);
  });

  it('deals each player the deck they chose', () => {
    const { match } = dealtMatch();
    // 45 cards each, all drawn from the real card database.
    expect(Object.keys(match.state!.cards)).toHaveLength(90);
    expect(match.seats.every((seat) => seat.deck !== null)).toBe(true);
  });

  it('reaches play once both players keep their opening hand', () => {
    const { match } = startedMatch();
    expect(match.state?.status.kind).toBe('playing');
  });

  it('turns away a third player', () => {
    const { manager, match } = seatedMatch();
    const result = manager.join(match.id, CAROL, 'Carol');

    expect(result).toEqual({ ok: false, code: 'MATCH_FULL' });
    expect(match.seats).toHaveLength(2);
  });

  it('lets a seated player reconnect without taking a new seat', () => {
    const { manager, match } = seatedMatch();
    manager.setConnected(match.id, ALICE, false);

    const result = manager.join(match.id, ALICE, 'Alice');

    expect(result.ok).toBe(true);
    expect(match.seats).toHaveLength(2);
    expect(match.seats.find((s) => s.playerId === ALICE)?.connected).toBe(true);
  });

  it('rejects actions from someone who is not seated', () => {
    const { manager, match } = seatedMatch();
    const result = manager.submitAction(match.id, CAROL, { type: 'END_PHASE' });

    expect(result.ok).toBe(false);
  });

  it('records applied actions so a match can be replayed', () => {
    const { manager, match } = startedMatch();
    const active = match.state?.turn.activePlayer;
    if (!active) throw new Error('expected a started match');

    const result = manager.submitAction(match.id, active, { type: 'END_PHASE' });

    expect(result.ok).toBe(true);
    expect(match.actions).toEqual([
      { actor: ALICE, action: { type: 'KEEP_HAND' } },
      { actor: BOB, action: { type: 'KEEP_HAND' } },
      { actor: active, action: { type: 'END_PHASE' } },
    ]);
  });

  it('rejects an unknown match', () => {
    const manager = new MatchManager();
    expect(manager.join(asMatchId('nope'), ALICE, 'Alice')).toEqual({
      ok: false,
      code: 'MATCH_NOT_FOUND',
    });
  });

  it('never hands a player their opponent view', () => {
    const { manager, match } = startedMatch();
    const aliceView = manager.viewFor(match.id, ALICE);

    expect(aliceView?.viewer).toBe(ALICE);
    const bobHand = match.state?.zoneOrder[`${BOB}:hand`] ?? [];
    for (const id of bobHand) {
      expect(aliceView?.cards[id]).toMatchObject({ hidden: true });
    }
  });

  describe('finding your way back into a game', () => {
    it('lists a match a disconnected player still holds a seat in', () => {
      const { manager, match } = startedMatch();
      // A dropped connection, not a departure: the seat stays.
      manager.setConnected(match.id, ALICE, false);

      const mine = manager.matchesFor(ALICE);
      expect(mine).toHaveLength(1);
      expect(mine[0]?.id).toBe(match.id);
      // And rejoining is the ordinary join, which puts them back in the seat.
      expect(manager.join(match.id, ALICE, 'Alice').ok).toBe(true);
      expect(match.seats.find((seat) => seat.playerId === ALICE)?.connected).toBe(true);
    });

    it('keeps the seat when a dealt match is left mid-game', () => {
      // Leaving a game in progress is not a vacancy — the player may be
      // reconnecting — so the match is still theirs to come back to.
      const { manager, match } = startedMatch();
      expect(manager.leave(match.id, ALICE)).toEqual({ left: true, removed: false });
      expect(manager.matchesFor(ALICE).map((m) => m.id)).toEqual([match.id]);
    });

    it('lists nothing for a player who was never seated', () => {
      const { manager } = startedMatch();
      expect(manager.matchesFor(CAROL)).toEqual([]);
    });

    it('does not offer a lobby that has never dealt', () => {
      // Reachable by its join code and through the browser. Offering
      // "rejoin" for a game nobody has played a turn of is a different thing.
      const { manager } = seatedMatch();
      expect(manager.matchesFor(ALICE)).toEqual([]);
    });

    it('does not offer a match that is already over', () => {
      const { manager, match } = startedMatch();
      manager.submitAction(match.id, ALICE, { type: 'CONCEDE' });
      expect(manager.matchesFor(ALICE)).toEqual([]);
      expect(manager.matchesFor(BOB)).toEqual([]);
    });
  });

  it('sweeps finished matches once everyone has left', () => {
    const { manager, match } = startedMatch();
    manager.submitAction(match.id, ALICE, { type: 'CONCEDE' });
    manager.setConnected(match.id, ALICE, false);
    manager.setConnected(match.id, BOB, false);

    expect(manager.sweep()).toBe(1);
    expect(manager.size).toBe(0);
  });
});
