import type { CardDefId, CardInstanceId, MatchId, PlayerId } from './ids.js';
import type { Rng } from './rng.js';

/**
 * The complete, authoritative state of a match, modelled on Rules.md.
 *
 * Invariants that the rest of the codebase relies on:
 *  - Plain JSON: no class instances, no `Date`, no `Map`/`Set`. It must survive
 *    `structuredClone` and `JSON.stringify` so it can be snapshotted and sent.
 *  - Server-only: clients receive a redacted `PlayerView` (see `view.ts`),
 *    never this object, or hidden information leaks.
 *  - Only `reduce()` produces new states, and only from an action + the state.
 */

/**
 * Private/shared zones. Cards on the field live in a city (`zone: 'city'` plus
 * a `cityIndex`), face-down as a Set Card or face-up once opened. Rules.md §7.
 */
export type ZoneId = 'deck' | 'hand' | 'trash' | 'city';

/** Zones whose contents are ordered and tracked per player. */
export type PlayerZoneId = Extract<ZoneId, 'deck' | 'hand' | 'trash'>;

/**
 * One of the five shared City cards forming the battlefield row. Rules.md §5.
 * Cities are shared terrain, not owned by either player.
 */
export interface City {
  /** Position in the row, 0-based. Distance between cities is index difference. */
  readonly index: number;
  readonly name: string;
  /** The Royal Capital is required for the occupation win. Rules.md §1. */
  readonly royalCapital: boolean;
  /** Turned face-up when a battle is declared here, and stays so. Rules.md §5. */
  readonly faceUp: boolean;
  /** Occupier, established by winning a battle here. Rules.md §12. */
  readonly occupiedBy: PlayerId | null;
}

/** One physical card in one match. */
export interface CardInstance {
  readonly instanceId: CardInstanceId;
  readonly defId: CardDefId;
  /** Seat that owns the card (returns here when it leaves play). */
  readonly owner: PlayerId;
  /** Seat currently controlling it — the player who opened it. Rules.md §14. */
  readonly controller: PlayerId;
  readonly zone: ZoneId;
  /** Which city it sits in. Set only while `zone === 'city'`. */
  readonly cityIndex?: number;
  /** On the field, `false` means it is still a face-down Set Card. Rules.md §7. */
  readonly faceUp: boolean;
  /** Locked = turned horizontal, having taken an action. Rules.md §6. */
  readonly locked: boolean;
  /** Damage marked this turn; cleared in the End phase. Rules.md §10 ⑤. */
  readonly damage: number;
  /** Counters keyed by name, for card effects that track state. */
  readonly counters: Readonly<Record<string, number>>;
}

export interface PlayerState {
  readonly id: PlayerId;
  readonly name: string;
  /**
   * A card number whose art is this player's badge, or absent for none.
   * Purely how they are drawn — nothing in the rules reads it — but it sits
   * beside the name because it is the same kind of fact about a seat.
   */
  readonly icon?: string;
  /** Set once this player has lost. There are no life totals in Berserk. */
  readonly eliminated: boolean;
  /** Connection state, so the UI can show "opponent disconnected". */
  readonly connected: boolean;
}

/**
 * A window in which one player may open a Quick. Rules.md §13, DesignNotes
 * "When to offer a Quick".
 *
 * Not the priority stack of §14: there is no stack of pending effects and no
 * interrupting an interrupt. A window is one player being asked "now?", and
 * it closes when they say no.
 */
export interface QuickWindow {
  /** The player being asked — whoever did *not* do the thing that opened it. */
  readonly waitingOn: PlayerId;
  readonly trigger: QuickTrigger;
  /**
   * Who is asked next, once this player has passed. Rules.md §13 — "when two
   * players want to use Quick simultaneously, the turn player goes first",
   * which is what happens before damage: the attacker is asked, and then the
   * defender. Absent for every window that asks one player only.
   */
  readonly then?: PlayerId;
}

/**
 * The moments a window can open at. DesignNotes "When to offer a Quick".
 *
 * `beforeDamage` is the one that is not about the opponent doing something:
 * it is the last chance to act before the Range bands resolve (Rules.md
 * §11 ④), and every combat Quick in the set — "+2/+2 until end of turn",
 * "deal 3 damage to a character in combat" — is written for it.
 */
export type QuickTrigger =
  'turnStart' | 'cardOpened' | 'mainPhase' | 'combat' | 'attack' | 'beforeDamage' | 'turnEnd';

/**
 * An effect that has stopped mid-resolution because it owes a player a choice.
 * Rules.md §13.
 *
 * Some printed lines cannot finish on their own: "discard 2 cards" and "add 1
 * Serpico from your deck to your hand" both name a number and leave the player
 * to say *which*. The effect resolves as far as it can, writes down what it
 * still owes, and the game waits — the same shape as a Quick window, and for
 * the same reason: the alternative is the engine choosing for the player, and
 * a card that says "discard 2" has not said "discard 2 at random".
 *
 * Only one is ever outstanding. These come out of a single effect resolving,
 * and an effect that owed two questions at once would be §14's stack, which is
 * not built. `then` chains run *after* the choice is answered, so a card whose
 * second half depends on the first still reads in printed order.
 */
export interface PendingChoice {
  /** The player being asked. Nothing else may happen until they answer. */
  readonly waitingOn: PlayerId;
  /** The card whose printed line asked, so the UI can name and show it. */
  readonly source: CardInstanceId;
  /** The printed line, so the prompt quotes the card rather than paraphrasing. */
  readonly text: string;
  /** How many cards are still owed. Counts down; the choice ends at zero. */
  readonly count: number;
  readonly kind: PendingChoiceKind;
}

export type PendingChoiceKind =
  /** Pitch from your own hand, your pick. Answered with `CHOOSE_CARD`. */
  | { readonly zone: 'hand'; readonly action: 'discard' }
  /**
   * Search your deck and take a card, then reshuffle. Rules.md §13.
   *
   * `named` is the printed restriction — "1 Serpico" — matched against the
   * card's *name*, not its id, because several printings share a name and the
   * line does not care which one is found. `null` is an unrestricted search.
   *
   * The deck is hidden from everyone (`view.ts`), so the view reveals exactly
   * the cards this choice may legally take and nothing else: a search that
   * showed the whole deck would leak the draw order it is about to reshuffle.
   */
  | { readonly zone: 'deck'; readonly action: 'toHand'; readonly named: string | null };

/** The five phases of a turn. Rules.md §10. */
export type PhaseId = 'refresh' | 'draw' | 'open' | 'main' | 'end';

/**
 * Turn structure as *data*, not control flow, so the phase order is reviewable
 * against Rules.md §10 rather than buried in the reducer.
 */
export interface PhaseDef {
  readonly id: PhaseId;
  readonly name: string;
  /** Resolves automatically and moves on without player input. */
  readonly autoAdvance: boolean;
}

export interface TurnState {
  /** Whose turn it is. */
  readonly activePlayer: PlayerId;
  /** Who may act right now — differs during response windows. Rules.md §14. */
  readonly priorityPlayer: PlayerId;
  /** Index into `GameState.phases`. */
  readonly phaseIndex: number;
  /** 1-based; increments when the turn passes back to the starting player. */
  readonly turnNumber: number;
  /** One open per turn is the game's core bottleneck. Rules.md §10 ③. */
  readonly openedThisTurn: boolean;
  /** Cities already battled this turn — one battle per city. Rules.md §10 ④. */
  readonly battledCities: readonly number[];
}

/**
 * The Battle phase, mid-flight. Rules.md §11 runs five steps in fixed order,
 * and each waits on a specific player, so the whole thing is a small state
 * machine rather than something the turn structure can express.
 *
 * Null when no battle is running — battle is declared from within Main and
 * returns there (§10 ④(4)), so it is not one of the five turn phases.
 */
export interface BattleState {
  /** The contested city. The attacker must not already occupy it. */
  readonly city: number;
  readonly attacker: PlayerId;
  readonly defender: PlayerId;
  readonly step: BattleStep;
  /** Whose move the current step is waiting on. */
  readonly waitingOn: PlayerId;
  /** The lead character, locked when designated. §11 ①. */
  readonly vanguard: CardInstanceId | null;
  /** Everyone committed to the fight, both sides. §11 ③. */
  readonly participants: readonly CardInstanceId[];
  /** Seats that have taken their one combat open. §11 ②. */
  readonly opened: readonly PlayerId[];
  /** Consecutive passes in the commit step; two ends it. §11 ③. */
  readonly passes: number;
  /**
   * Characters still to assign damage in the current Range band, in order.
   * Damage runs highest Range first, and ties assign attacker-first. §11 ④.
   */
  readonly assigning: readonly CardInstanceId[];
  /**
   * Damage assigned in the current band but not yet applied. A band resolves
   * together, so a character destroyed by it still deals its own damage. §11 ④.
   */
  readonly pending: readonly {
    /** Who dealt it — needed for the event, since the band resolves later. */
    readonly source: CardInstanceId;
    readonly target: CardInstanceId;
    readonly amount: number;
  }[];
  /**
   * Participants that have already struck. Each assigns once, in Range order
   * (§11 ④) — without this the highest Range would come round again and
   * strike forever.
   */
  readonly struck: readonly CardInstanceId[];
}

/** The steps of the Battle phase, in the order Rules.md §11 fixes them. */
export type BattleStep = 'vanguard' | 'opens' | 'commit' | 'damage';

/** How a battle ended. Rules.md §12. */
export type BattleResult = 'occupation' | 'repel' | 'stalemate' | 'mutual_destruction';

export type MatchStatus =
  | { readonly kind: 'setup' }
  | { readonly kind: 'playing' }
  | { readonly kind: 'finished'; readonly winner: PlayerId | null; readonly reason: WinReason };

/** Why the match ended. Occupation and deck-out are Rules.md §1. */
export type WinReason = 'occupation' | 'deck_out' | 'concede';

export interface GameState {
  readonly matchId: MatchId;
  /** Bumped on every applied action; clients use it to detect dropped updates. */
  readonly version: number;
  readonly status: MatchStatus;
  /** Seat order — index 0 goes first. */
  readonly seats: readonly PlayerId[];
  readonly players: Readonly<Record<string, PlayerState>>;
  /** The shared row of City cards. Rules.md §5. */
  readonly cities: readonly City[];
  /** Every card in the match, keyed by instance id. */
  readonly cards: Readonly<Record<string, CardInstance>>;
  /** Ordering for deck/hand/trash, which `cards` alone cannot express. */
  readonly zoneOrder: Readonly<Record<string, readonly CardInstanceId[]>>;
  readonly phases: readonly PhaseDef[];
  readonly turn: TurnState;
  /**
   * Seats that have not yet kept their opening hand. While non-empty the match
   * is in `setup` and only mulligan decisions are legal. Rules.md §9.
   */
  readonly mulliganPending: readonly PlayerId[];
  /**
   * How many cards each seat must still put on the bottom of their deck,
   * keyed by player. Only set once a player has decided to keep — the choice
   * comes first, the cost after. DesignNotes 5.
   */
  readonly pendingBottom: Readonly<Record<string, number>>;
  /**
   * The hand size each seat must end setup on, keyed by player. Starts at
   * seven and drops by one per mulligan; keeping a hand larger than this is
   * what obliges a player to bottom cards.
   */
  readonly handTarget: Readonly<Record<string, number>>;
  /** The battle in progress, or null. Rules.md §11. */
  readonly battle: BattleState | null;
  /**
   * A player being asked whether they want to open a Quick right now, or null
   * when nobody is. While it is set, nothing else in the game may happen:
   * that is the whole point of an interrupt. Rules.md §13.
   */
  readonly quick: QuickWindow | null;
  /**
   * An effect waiting on a player to say which cards, or null when none is.
   * Like a Quick window it stops everything else; unlike one it is not
   * optional, because the effect is already resolving. Rules.md §13.
   */
  readonly pending: PendingChoice | null;
  readonly rng: Rng;
  /** Append-only log of everything that happened, for replay and the UI feed. */
  readonly log: readonly GameEvent[];
}

/* ------------------------------------------------------------------ actions */

/**
 * Everything a player can ask the engine to do. Clients send these; the server
 * validates and applies them. Never trust an action's payload — `reduce()`
 * re-checks legality regardless of what the UI offered.
 */
export type GameAction =
  | { readonly type: 'CONCEDE' }
  /** Finish the current phase. Rules.md §10. */
  | { readonly type: 'END_PHASE' }
  /** Place a card from hand face-down into a city. Rules.md §10 ④(2). */
  | { readonly type: 'SET_CARD'; readonly card: CardInstanceId; readonly city: number }
  /**
   * Flip a Set Card face-up and pay its cost. `pay` lists the cards discarded
   * from hand to satisfy the cost icons. Rules.md §7.
   */
  | {
      readonly type: 'OPEN_CARD';
      readonly card: CardInstanceId;
      readonly pay: readonly CardInstanceId[];
      /**
       * One chosen character per on-open ability that asks for a target, in
       * the order those abilities are printed. Rules.md §13. Like `pay`, the
       * engine offers a legal set and accepts any other legal one — the
       * choice is the player's.
       */
      readonly targets?: readonly CardInstanceId[];
      /**
       * One chosen *area* per ability that asks for one, in the same printed
       * order. Rules.md §13 — separate from `targets` because an area is not
       * a card: BK1-032 moves an enemy character (a target) to an adjacent
       * area (an area), and an ability can want either, both or neither.
       */
      readonly areas?: readonly number[];
    }
  /** Lock an unlocked character and move it within its Move range. Rules.md §10 ④(1). */
  | { readonly type: 'MOVE_CHARACTER'; readonly card: CardInstanceId; readonly city: number }
  /** Discard down to the hand limit in the End phase. Rules.md §10 ⑤. */
  | { readonly type: 'DISCARD_CARD'; readonly card: CardInstanceId }
  /**
   * Answer the outstanding {@link PendingChoice} with one card. Rules.md §13.
   *
   * One card per action even when the effect owes several, so a player who has
   * picked their first discard is not made to name both at once — the choice
   * counts down and the game asks again.
   */
  | { readonly type: 'CHOOSE_CARD'; readonly card: CardInstanceId }
  /** Shuffle your hand back, redraw, and bottom cards. Rules.md §9, DesignNotes 5. */
  | { readonly type: 'MULLIGAN' }
  /** Put one of the redrawn cards on the bottom of your deck. DesignNotes 5. */
  | { readonly type: 'BOTTOM_CARD'; readonly card: CardInstanceId }
  /** Keep the current opening hand and begin play. Rules.md §9. */
  | { readonly type: 'KEEP_HAND' }
  /** Declare battle against a city you do not occupy. Rules.md §10 ④(4), §11. */
  | { readonly type: 'DECLARE_BATTLE'; readonly city: number }
  /** Name the lead character, locking it. Rules.md §11 ①. */
  | { readonly type: 'DESIGNATE_VANGUARD'; readonly card: CardInstanceId }
  /** Add a character to the battle, locking it. Rules.md §11 ③. */
  | { readonly type: 'COMMIT_CHARACTER'; readonly card: CardInstanceId }
  /**
   * Decline whatever the current battle step is asking for: no vanguard (which
   * ends the battle), no combat open, or no further commitment. Rules.md §11.
   */
  | { readonly type: 'BATTLE_PASS' }
  /**
   * Split one character's Power among enemy participants. Rules.md §11 ④.
   * The amounts must total exactly its Power.
   */
  | {
      readonly type: 'ASSIGN_DAMAGE';
      readonly card: CardInstanceId;
      readonly hits: readonly { readonly target: CardInstanceId; readonly amount: number }[];
    }
  /** Use a character or Eternal ability. Rules.md §13. */
  | {
      readonly type: 'USE_ABILITY';
      readonly card: CardInstanceId;
      readonly ability: string;
      readonly targets?: readonly CardInstanceId[];
      /** Chosen areas, for an ability that asks for one. See `OPEN_CARD`. */
      readonly areas?: readonly number[];
      readonly pay?: readonly CardInstanceId[];
    }
  /** Decline to interrupt a pending effect. Rules.md §14. */
  | { readonly type: 'PASS_PRIORITY' };

export type GameActionType = GameAction['type'];

/** An action paired with who sent it. This is the unit the server persists. */
export interface PlayerAction {
  readonly actor: PlayerId;
  readonly action: GameAction;
}

/* ------------------------------------------------------------------- events */

/**
 * What actually happened, emitted by `reduce()`. One action can produce many
 * events. The client animates from these; it never re-derives them.
 */
export type GameEvent =
  | { readonly type: 'MATCH_STARTED'; readonly firstPlayer: PlayerId }
  | { readonly type: 'MULLIGANED'; readonly player: PlayerId; readonly handSize: number }
  | { readonly type: 'CARD_BOTTOMED'; readonly player: PlayerId; readonly card: CardInstanceId }
  | { readonly type: 'TURN_STARTED'; readonly player: PlayerId; readonly turnNumber: number }
  | { readonly type: 'PHASE_CHANGED'; readonly phaseId: PhaseId; readonly player: PlayerId }
  | { readonly type: 'PRIORITY_CHANGED'; readonly player: PlayerId }
  | { readonly type: 'CARDS_UNLOCKED'; readonly player: PlayerId; readonly count: number }
  | { readonly type: 'CARD_DRAWN'; readonly player: PlayerId; readonly card: CardInstanceId }
  | { readonly type: 'CARD_RETURNED'; readonly player: PlayerId; readonly card: CardInstanceId }
  | {
      /** A player is being offered the chance to open a Quick. Rules.md §13. */
      readonly type: 'QUICK_OFFERED';
      readonly player: PlayerId;
      readonly trigger: QuickTrigger;
    }
  | { readonly type: 'QUICK_DECLINED'; readonly player: PlayerId }
  | {
      /**
       * An effect stopped to ask a player which cards. Rules.md §13. The
       * client raises the picker from this; `count` is what is still owed.
       */
      readonly type: 'CHOICE_REQUIRED';
      readonly player: PlayerId;
      readonly card: CardInstanceId;
      readonly text: string;
      readonly count: number;
    }
  | {
      /**
       * A card was taken out of a deck by a search. Rules.md §13.
       *
       * The card id is public — it is in the taker's hand now, and the view
       * redacts what an opponent may not identify — but the *event* says the
       * deck was searched, which is why the shuffle that follows is not a
       * desync. Separate from `CARD_DRAWN` because a draw takes the top card
       * and this does not.
       */
      readonly type: 'DECK_SEARCHED';
      readonly player: PlayerId;
      readonly card: CardInstanceId;
    }
  | {
      /**
       * A player chose to use a cost-bearing ability and paid for it.
       * Rules.md §13 — the cost is spent here, whatever the effect then
       * finds. `ABILITY_RESOLVED` follows with the printed line.
       */
      readonly type: 'ABILITY_USED';
      readonly player: PlayerId;
      readonly card: CardInstanceId;
      readonly ability: string;
    }
  | {
      /**
       * A card's printed ability did something. Rules.md §13. Carries the
       * printed line so the feed can say what happened in the card's own
       * words rather than in the engine's.
       */
      readonly type: 'ABILITY_RESOLVED';
      readonly player: PlayerId;
      readonly card: CardInstanceId;
      readonly text: string;
    }
  | {
      /**
       * The ability went off and found nothing to act on. Rules.md §13
       * resolves what it can, and "+2/+2 for each enemy here" across an
       * empty area is nothing — but a card that comes forward, is read out,
       * and changes nothing looks broken unless the game says so. Follows
       * the `ABILITY_RESOLVED` it qualifies.
       */
      readonly type: 'ABILITY_FIZZLED';
      readonly player: PlayerId;
      readonly card: CardInstanceId;
      readonly text: string;
    }
  | {
      readonly type: 'CARD_SET';
      readonly player: PlayerId;
      readonly card: CardInstanceId;
      readonly city: number;
    }
  | {
      readonly type: 'CARD_OPENED';
      readonly player: PlayerId;
      readonly card: CardInstanceId;
      readonly city: number;
    }
  | {
      readonly type: 'COST_PAID';
      readonly player: PlayerId;
      readonly cards: readonly CardInstanceId[];
    }
  | {
      readonly type: 'CHARACTER_MOVED';
      readonly card: CardInstanceId;
      readonly from: number;
      readonly to: number;
    }
  | {
      readonly type: 'CARD_TRASHED';
      readonly player: PlayerId;
      readonly card: CardInstanceId;
    }
  | {
      readonly type: 'DAMAGE_DEALT';
      readonly source: CardInstanceId;
      readonly target: CardInstanceId;
      readonly amount: number;
      /**
       * A blow struck in a battle (Rules.md §11 ④) rather than dealt by an
       * effect (§13). Both mark the same damage, so nothing in the rules
       * turns on it — but they do not *look* alike, and a client cannot tell
       * them apart from the state that results.
       */
      readonly combat: boolean;
    }
  | { readonly type: 'CHARACTER_DESTROYED'; readonly card: CardInstanceId }
  | {
      readonly type: 'BATTLE_DECLARED';
      readonly city: number;
      readonly attacker: PlayerId;
    }
  | { readonly type: 'VANGUARD_DESIGNATED'; readonly card: CardInstanceId }
  | {
      readonly type: 'CHARACTER_COMMITTED';
      readonly card: CardInstanceId;
      readonly player: PlayerId;
    }
  | { readonly type: 'BATTLE_STEP'; readonly step: BattleStep; readonly waitingOn: PlayerId }
  | {
      readonly type: 'BATTLE_ENDED';
      readonly city: number;
      readonly result: BattleResult;
      readonly occupier: PlayerId | null;
    }
  | { readonly type: 'DAMAGE_CLEARED' }
  | {
      readonly type: 'CITY_FLIPPED';
      readonly city: number;
      readonly faceUp: boolean;
      readonly cityLevel: number;
    }
  | {
      readonly type: 'CITY_OCCUPIED';
      readonly city: number;
      readonly player: PlayerId | null;
    }
  | {
      readonly type: 'MATCH_ENDED';
      readonly winner: PlayerId | null;
      readonly reason: WinReason;
    };

export type GameEventType = GameEvent['type'];
