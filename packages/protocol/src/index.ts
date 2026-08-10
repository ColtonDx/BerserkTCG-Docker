import type {
  GameAction,
  GameEvent,
  MatchId,
  PlayerId,
  PlayerView,
  RuleViolation,
} from '@berserk/engine';

/**
 * The wire contract between the browser client and the game server.
 *
 * Both sides import these types, so a change here is a compile error on
 * whichever side forgot to update. Rules of the road:
 *  - The server is authoritative. Clients send *intents*; they never send state.
 *  - Clients never name themselves. The socket is authenticated at handshake
 *    with a session token, and the seat's `playerId` and display name come
 *    from that account — a claimed identity in a payload would be worth
 *    nothing, so none of these messages carries one.
 *  - The server replies with a redacted `PlayerView`, never a `GameState`.
 *  - Message names are versioned by `PROTOCOL_VERSION`; bump it on any
 *    breaking change so old tabs are told to reload instead of silently
 *    desyncing.
 */
export const PROTOCOL_VERSION = 2;

/**
 * How long the turn/phase banner stays on screen, in milliseconds.
 *
 * Shared because both sides have to agree on it: the client shows the banner
 * for this long, and the computer opponent must not start playing underneath
 * one. Written down once so raising it in the UI cannot silently leave the
 * AI moving too early.
 */
export const BANNER_HOLD_MS = 4200;

/**
 * How long the opening ceremony runs before a player is asked anything, in
 * milliseconds.
 *
 * The client burns the menu off the board, then tosses for first player
 * (Rules.md §9.2), and only then asks about the opening hand (§9.4). Shared
 * for the same reason as the banner above: the computer opponent settles its
 * own hand during setup, and doing that underneath the ceremony puts shuffle
 * sounds and a redealt hand behind an animation the human is still watching.
 *
 * The sum of the client's own timings, with a little slack: the burn is
 * 1875ms (`BurnAway.DURATION`) and the toss 1700 + 2400ms (`CoinFlip`'s
 * `SPIN_MS` and `HOLD_MS`), so 5975ms of ceremony and 325ms spare. Raising
 * any of those should raise this, or Femto starts moving early again.
 */
export const OPENING_CEREMONY_MS = 6300;

/* ------------------------------------------------------- client -> server */

export interface ClientToServerEvents {
  /** Join (or rejoin) a match as a seated player. */
  'match:join': (payload: { matchId: MatchId }, ack: (result: JoinResult) => void) => void;

  /**
   * Start a match against the computer. Both seats are filled at once, so it
   * goes straight to choosing a deck.
   */
  'match:createSolo': (ack: (result: JoinResult) => void) => void;

  /** Create a new match and take the first seat. */
  'match:create': (ack: (result: JoinResult) => void) => void;

  /** Leave the current match. */
  'match:leave': (payload: { matchId: MatchId }) => void;

  /** Submit an intent. The server validates it before anything happens. */
  'action:submit': (
    payload: { matchId: MatchId; action: GameAction },
    ack: (result: ActionResult) => void,
  ) => void;

  /** Ask for a full view, e.g. after a reconnect or a detected version gap. */
  'state:resync': (payload: { matchId: MatchId }, ack: (view: PlayerView | null) => void) => void;

  /** Matches waiting for an opponent, for the lobby browser. */
  'lobbies:browse': (payload: Record<string, never>, ack: (result: OpenMatch[]) => void) => void;

  /**
   * Games this account is still seated in, so a dropped player can get back
   * to one. The seat survives a disconnect; this is how it is found again.
   */
  'matches:mine': (payload: Record<string, never>, ack: (result: OngoingMatch[]) => void) => void;

  /**
   * Choose the deck to play. The match deals once both seats have chosen a
   * legal deck. DesignNotes 4.
   */
  'match:selectDeck': (
    payload: { matchId: MatchId; deckId: string },
    ack: (result: SelectDeckResult) => void,
  ) => void;
}

/* ------------------------------------------------------- server -> client */

export interface ServerToClientEvents {
  /** Authoritative state after any change. Always replaces local state. */
  'state:update': (payload: StateUpdate) => void;

  /** What just happened, for animation and the log feed. */
  'events:applied': (payload: { matchId: MatchId; events: readonly GameEvent[] }) => void;

  /** A seat connected, disconnected, or was filled. */
  'match:presence': (payload: {
    matchId: MatchId;
    players: readonly { playerId: PlayerId; displayName: string; connected: boolean }[];
  }) => void;

  /** The match ended. */
  'match:ended': (payload: { matchId: MatchId; winner: PlayerId | null; reason: string }) => void;

  /** Who has chosen a deck, while a match waits to deal. DesignNotes 4. */
  'match:lobby': (payload: MatchLobby) => void;

  /** Something went wrong outside the rules (bad room, server fault). */
  'error:server': (payload: { code: ServerErrorCode; message: string }) => void;
}

export interface StateUpdate {
  readonly matchId: MatchId;
  readonly view: PlayerView;
}

export type JoinResult =
  | {
      readonly ok: true;
      readonly matchId: MatchId;
      readonly seat: PlayerId;
      /** Null while the match is still waiting for an opponent to sit down. */
      readonly view: PlayerView | null;
    }
  | { readonly ok: false; readonly code: ServerErrorCode; readonly message: string };

/** A match waiting for an opponent, as shown in the lobby browser. */
export interface OpenMatch {
  readonly matchId: MatchId;
  readonly host: string;
  readonly seats: number;
  readonly capacity: number;
  /** Milliseconds since the match was made. */
  readonly age: number;
}

/**
 * A match in progress that the asking account holds a seat in — what the main
 * menu offers to rejoin.
 *
 * Everything here is already known to this player: they are seated in it. The
 * opponent's *name* is public, their hand is not, and nothing about the
 * position travels in this message — rejoining goes through `match:join`,
 * which answers with a properly redacted view.
 */
export interface OngoingMatch {
  readonly matchId: MatchId;
  /** The other seat's display name, or null if the seat is empty. */
  readonly opponent: string | null;
  /** Whether the opponent is connected right now. */
  readonly opponentConnected: boolean;
  /** Whose turn it is, so a player can see whether they are being waited on. */
  readonly yourTurn: boolean;
  readonly turnNumber: number;
  /** Milliseconds since the match was made. */
  readonly age: number;
}

/** A match that has players but has not dealt yet. */
export interface MatchLobby {
  readonly matchId: MatchId;
  readonly seats: readonly {
    readonly playerId: PlayerId;
    readonly displayName: string;
    readonly connected: boolean;
    /** Null until this seat has chosen a deck. */
    readonly deckName: string | null;
  }[];
  /** True once both seats hold a legal deck and the match is dealing. */
  readonly starting: boolean;
}

export type SelectDeckResult =
  | { readonly ok: true; readonly deckName: string }
  | { readonly ok: false; readonly message: string };

export type ActionResult =
  | { readonly ok: true; readonly version: number }
  | { readonly ok: false; readonly violation: RuleViolation };

export type ServerErrorCode =
  'MATCH_NOT_FOUND' | 'MATCH_FULL' | 'NOT_A_PLAYER' | 'PROTOCOL_MISMATCH' | 'INTERNAL';

/** Socket.IO namespace the game runs on. */
export const GAME_NAMESPACE = '/game';
