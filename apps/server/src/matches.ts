import {
  asCardDefId,
  asMatchId,
  catalogueRegistry,
  createEngine,
  expandDeck,
  summariseDeck,
  type DeckEntry,
  type Engine,
  type GameAction,
  type GameEvent,
  type GameState,
  type MatchId,
  type PlayerId,
  type PlayerView,
  type RuleViolation,
} from '@berserk/engine';
import { randomInt } from 'node:crypto';

/**
 * In-memory match registry — the authoritative home of every live game.
 *
 * The server owns `GameState`; clients only ever receive redacted views. All
 * mutation goes through `submitAction`, which is a thin wrapper around the
 * engine's `reduce`. Keeping the rules out of this file is deliberate: if game
 * logic starts appearing here, it belongs in `@berserk/engine` instead.
 *
 * State is lost on restart. Persisting matches (Postgres) is a later step; the
 * `actions` log kept here is exactly what a replay/restore would need.
 */

export interface Seat {
  readonly playerId: PlayerId;
  displayName: string;
  /** The card whose art is this player's badge, if they have chosen one. */
  icon: string | null;
  connected: boolean;
  /** True for the computer opponent, which plays itself. */
  readonly ai: boolean;
  /** The deck this seat will play. Null until chosen. DesignNotes 4. */
  deck: { id: string; name: string; cards: readonly DeckEntry[] } | null;
}

export interface Match {
  readonly id: MatchId;
  readonly seats: Seat[];
  /** Null until both seats are filled and the game starts. */
  state: GameState | null;
  /** Every applied action, in order — a replay of the match from its seed. */
  readonly actions: { actor: PlayerId; action: GameAction }[];
  readonly seed: number;
  readonly createdAt: number;
}

const MAX_SEATS = 2;

/**
 * Join codes are six digits, so they can be read aloud or typed quickly.
 * Leading zeros are kept, hence a string rather than a number.
 */
const CODE_DIGITS = 6;
const CODE_RANGE = 10 ** CODE_DIGITS;

export class MatchManager {
  private readonly matches = new Map<MatchId, Match>();

  constructor(private readonly engine: Engine = createEngine(catalogueRegistry())) {}

  /** An unused six-digit code. */
  private newCode(): MatchId {
    // A million codes against a handful of live matches: a collision is
    // unlikely, and retrying costs nothing when it happens.
    for (let attempt = 0; attempt < 50; attempt++) {
      const code = asMatchId(String(randomInt(0, CODE_RANGE)).padStart(CODE_DIGITS, '0'));
      if (!this.matches.has(code)) return code;
    }
    throw new Error('Could not find a free join code');
  }

  create(): Match {
    const match: Match = {
      id: this.newCode(),
      seats: [],
      state: null,
      actions: [],
      // Seeded from a CSPRNG so players cannot predict their shuffle.
      seed: randomInt(0, 2 ** 31 - 1),
      createdAt: Date.now(),
    };
    this.matches.set(match.id, match);
    return match;
  }

  get(matchId: MatchId): Match | undefined {
    return this.matches.get(matchId);
  }

  /**
   * Matches anyone may walk into: seated but not full, and not yet dealt.
   * Newest first, so a freshly made match is easy to find.
   */
  openMatches(): Match[] {
    return [...this.matches.values()]
      .filter(
        (match) =>
          !match.state &&
          match.seats.length > 0 &&
          match.seats.length < MAX_SEATS &&
          // A single-player match is already full; it just has not dealt yet.
          !match.seats.some((seat) => seat.ai),
      )
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Finds a match waiting for an opponent, or creates one. */
  findOrCreateOpen(): Match {
    for (const match of this.matches.values()) {
      if (match.seats.length < MAX_SEATS && !match.state) return match;
    }
    return this.create();
  }

  /**
   * Seats a player, or reconnects them if they already hold a seat.
   * Starts the game once both seats are filled.
   */
  join(
    matchId: MatchId,
    playerId: PlayerId,
    displayName: string,
    icon: string | null = null,
  ): { ok: true; match: Match } | { ok: false; code: 'MATCH_NOT_FOUND' | 'MATCH_FULL' } {
    const match = this.matches.get(matchId);
    if (!match) return { ok: false, code: 'MATCH_NOT_FOUND' };

    const existing = match.seats.find((s) => s.playerId === playerId);
    if (existing) {
      existing.connected = true;
      existing.displayName = displayName;
      existing.icon = icon;
      return { ok: true, match };
    }

    if (match.seats.length >= MAX_SEATS) return { ok: false, code: 'MATCH_FULL' };
    // Seating no longer deals: both players pick a deck first (DesignNotes 4).
    match.seats.push({
      playerId,
      displayName,
      icon: icon ?? null,
      connected: true,
      ai: false,
      deck: null,
    });
    return { ok: true, match };
  }

  /**
   * Takes a player out of a match.
   *
   * Before the deal, the seat is freed and an empty match is dropped, so
   * nobody is left holding a lobby they walked away from. Once a match has
   * dealt, the seat is kept and only marked away — leaving mid-game is a
   * concede, not a vacancy, and the player may be reconnecting.
   */
  leave(matchId: MatchId, playerId: PlayerId): { left: boolean; removed: boolean } {
    const match = this.matches.get(matchId);
    if (!match) return { left: false, removed: false };

    if (match.state) {
      this.setConnected(matchId, playerId, false);
      return { left: true, removed: false };
    }

    const before = match.seats.length;
    const index = match.seats.findIndex((seat) => seat.playerId === playerId);
    if (index !== -1) match.seats.splice(index, 1);

    // A match holding nothing but the computer opponent is finished with.
    if (match.seats.length === 0 || match.seats.every((seat) => seat.ai)) {
      this.matches.delete(matchId);
      return { left: index !== -1, removed: true };
    }
    return { left: match.seats.length !== before, removed: false };
  }

  setConnected(matchId: MatchId, playerId: PlayerId, connected: boolean): void {
    const seat = this.matches.get(matchId)?.seats.find((s) => s.playerId === playerId);
    if (seat) seat.connected = connected;
  }

  /**
   * Validates and applies a player action. This is the only path that changes
   * a match, so it is also the only place that needs to be trusted.
   */
  submitAction(
    matchId: MatchId,
    actor: PlayerId,
    action: GameAction,
  ):
    | { ok: true; match: Match; state: GameState; events: readonly GameEvent[] }
    | { ok: false; violation: RuleViolation } {
    const match = this.matches.get(matchId);
    if (!match?.state) {
      return { ok: false, violation: { code: 'GAME_OVER', message: 'Match is not in progress.' } };
    }
    if (!match.seats.some((s) => s.playerId === actor)) {
      return {
        ok: false,
        violation: { code: 'NOT_YOUR_TURN', message: 'You are not seated here.' },
      };
    }

    const result = this.engine.reduce(match.state, actor, action);
    if (!result.ok) return { ok: false, violation: result.error };

    match.state = result.value.state;
    match.actions.push({ actor, action });
    return { ok: true, match, state: match.state, events: result.value.events };
  }

  /** Seats a computer opponent, for a single-player match. */
  seatAi(matchId: MatchId, playerId: PlayerId, displayName: string): boolean {
    const match = this.matches.get(matchId);
    if (!match || match.state || match.seats.length >= MAX_SEATS) return false;
    match.seats.push({
      playerId,
      displayName,
      icon: null,
      connected: true,
      ai: true,
      deck: null,
    });
    return true;
  }

  /** What a seat may legally do now. The AI reads its options from here. */
  legalActions(matchId: MatchId, playerId: PlayerId) {
    const state = this.matches.get(matchId)?.state;
    return state ? this.engine.legalActions(state, playerId) : [];
  }

  /** The redacted view a given seat is allowed to see. */
  viewFor(matchId: MatchId, playerId: PlayerId): PlayerView | null {
    const state = this.matches.get(matchId)?.state;
    return state ? this.engine.viewFor(state, playerId) : null;
  }

  /** Drops finished and abandoned matches. Call periodically. */
  sweep(maxAgeMs = 6 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const [id, match] of this.matches) {
      const finished = match.state?.status.kind === 'finished';
      const abandoned = match.seats.every((s) => !s.connected);
      if ((finished && abandoned) || match.createdAt < cutoff) {
        this.matches.delete(id);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.matches.size;
  }

  /**
   * Records a seat's deck, and deals once both seats hold a legal one.
   *
   * Legality is re-checked here even though the deckbuilder checks it too: a
   * deck can be saved illegal and edited elsewhere, and the client is never
   * the authority on rules.
   */
  chooseDeck(
    matchId: MatchId,
    playerId: PlayerId,
    deck: { id: string; name: string; cards: readonly DeckEntry[] },
  ): { ok: true; match: Match } | { ok: false; message: string } {
    const match = this.matches.get(matchId);
    if (!match) return { ok: false, message: 'No such match.' };
    if (match.state) return { ok: false, message: 'The match has already started.' };

    const seat = match.seats.find((s) => s.playerId === playerId);
    if (!seat) return { ok: false, message: 'You are not seated here.' };

    const summary = summariseDeck(deck.cards);
    if (!summary.legal) {
      return { ok: false, message: summary.errors.map((e) => e.message).join(' ') };
    }

    seat.deck = deck;
    if (match.seats.length === MAX_SEATS && match.seats.every((s) => s.deck)) {
      this.start(match);
    }
    return { ok: true, match };
  }

  /** True once both seats are filled and both have chosen a deck. */
  readyToStart(match: Match): boolean {
    return match.seats.length === MAX_SEATS && match.seats.every((s) => s.deck !== null);
  }

  private start(match: Match): void {
    const [first, second] = match.seats;
    if (!first?.deck || !second?.deck)
      throw new Error('start() called before both decks were chosen');

    match.state = this.engine.createMatch({
      matchId: match.id,
      seed: match.seed,
      decks: [
        {
          playerId: first.playerId,
          name: first.displayName,
          icon: first.icon ?? undefined,
          cards: expandDeck(first.deck.cards).map(asCardDefId),
        },
        {
          playerId: second.playerId,
          name: second.displayName,
          icon: second.icon ?? undefined,
          cards: expandDeck(second.deck.cards).map(asCardDefId),
        },
      ],
    });
  }
}
