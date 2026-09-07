import type { CardInstance, GameState } from './types.js';
import type { CardColor } from './cards.js';
import type { CardInstanceId, PlayerId } from './ids.js';

/**
 * What cards actually do. Rules.md §13.
 *
 * The printed rules text lives on `CardDefinition.text` and is never read by
 * the engine. Behaviour lives here, as data: a card's entry says when its
 * ability goes off, what has to be true, and what it does. Nothing parses
 * English, so a card whose behaviour is not written here does nothing at all
 * rather than doing something approximate.
 *
 * Every entry carries the line it stands for in `text`. When the two disagree
 * the printed line wins — that is the point of keeping them side by side.
 */

/**
 * Whose cards an effect acts on.
 *
 * `occupier` is not a side but a position: the player holding the area the
 * source sits in, which BK1-104 asks about on *each* player's turn and which
 * may be nobody. An effect naming it does nothing while the city is unheld.
 */
export type EffectPlayer = 'you' | 'opponent' | 'occupier';

/** A change to a character's printed numbers. Absent fields are unchanged. */
export interface StatLine {
  readonly power?: number;
  readonly hp?: number;
  readonly move?: number;
}

/**
 * What an attachment lends its host. Range is here and not in `StatLine`
 * because nothing else in the set moves it: it is printed-only everywhere but
 * on a character wearing a Sylph Sword (BK1-076). Rules.md §11 ④.
 */
export interface Grants extends StatLine {
  readonly range?: number;
}

/**
 * Which cards an ability reaches, relative to the card that has it.
 *
 * Defaults are the narrow reading: the source itself, its controller's side,
 * the area it stands in. Widening is always explicit, because an ability that
 * accidentally reaches the whole board is not something a test would notice.
 */
export interface Selector {
  /**
   * `self` is the source; `others` excludes it; `any` includes it; `target`
   * is whichever character the player chose, and reaches nothing on its own.
   */
  readonly scope?: 'self' | 'others' | 'any' | 'target';
  readonly side?: 'yours' | 'theirs' | 'any';
  /**
   * `thisArea` is the source's own city, `anywhere` the whole board, and
   * `elsewhere` every city *but* the source's own (BK1-154, "characters that
   * are not in this area").
   */
  readonly where?: 'thisArea' | 'anywhere' | 'elsewhere';
  /** One printed subtype token, e.g. `hawk`. See `build-catalogue.py`. */
  readonly subtype?: string;
  /** Only characters at or below this printed Level. Rules.md §7. */
  readonly maxLevel?: number;
  /** Only characters of this printed colour. Rules.md §3. */
  readonly colour?: CardColor;
  /**
   * Face-down Set Cards instead of open characters. Rules.md §7.
   *
   * The default reaches face-up characters, because all but one effect in the
   * set is about people standing in an area. A selector that says this reaches
   * the other population entirely — cards lying face down, whatever they are —
   * and never both, so "all set cards you control" cannot quietly sweep up a
   * character too.
   */
  readonly faceDown?: boolean;
  /**
   * How many cities away the effect reaches. Rules.md §15 "Distance" — 1 is
   * an adjacent city, counted from the source's own area, which is therefore
   * always included. Widens `where: 'thisArea'` rather than replacing it,
   * exactly as {@link TargetSpec.maxDistance} does.
   */
  readonly maxDistance?: number;
  /**
   * Only characters committed to the battle running right now. Rules.md §11
   * ③. With no battle on, nothing qualifies — so BK1-103 opened outside a
   * fight reaches nobody, which is the printed behaviour.
   */
  readonly inCombat?: boolean;
  /**
   * Face-up Effect cards rather than characters — "all eternal effect cards
   * in play" (BK1-152). Rules.md §3.
   *
   * The default population is characters, because all but a handful of
   * effects are about people standing in an area. This reaches the standing
   * Effect cards instead: an Eternal one sits on the board doing its work,
   * and is a legitimate thing to sweep off it.
   */
  readonly effectCards?: 'eternal' | 'normal' | 'any';
}

/**
 * Which characters an ability may be pointed at, when it asks the player to
 * choose one. Rules.md §13 — "target 1 character in this area".
 *
 * Separate from {@link Selector} because the two answer different questions:
 * a selector says which cards an effect reaches *automatically*, while this
 * says which ones the player is allowed to pick between. Defaults are the
 * wide reading here — a card that says "target 1 character" means either
 * side's — and narrowing is explicit.
 */
export interface TargetSpec {
  readonly side?: 'yours' | 'theirs' | 'any';
  readonly where?: 'thisArea' | 'anywhere';
  readonly subtype?: string;
  /** Rules.md §7 — some effects only reach small characters. */
  readonly maxLevel?: number;
  /** Rules.md §3 — some effects only reach one colour. */
  readonly colour?: CardColor;
  /**
   * Only characters committed to the battle running right now. Rules.md §11 ③
   * — "currently in combat". With no battle on, nothing qualifies, so the
   * ability has nobody to point at and is never offered.
   */
  readonly inCombat?: boolean;
  /**
   * Only characters on the attacking side of the battle running right now
   * (BK1-034, "target attacking character"). Rules.md §11.
   *
   * Narrower than `inCombat`: a defender committed to the same fight is in
   * combat but is not attacking. With no battle on, nothing qualifies.
   */
  readonly attacking?: boolean;
  /**
   * Point at a face-down Set Card instead of a standing character (BK1-146,
   * "destroy a set card in this area"). Rules.md §7.
   *
   * The two populations never mix, exactly as in {@link Selector.faceDown}:
   * a spec that says this reaches cards lying face down, whatever they are,
   * and never a character. `openCard` is the other reading — BK1-153's
   * "target open card" is the default population, since an open card is one
   * standing face up.
   */
  readonly faceDown?: boolean;
  /** Only characters that are unlocked. Rules.md §6. */
  readonly unlocked?: boolean;
  /**
   * "Target **another** character" — the source may not point at itself.
   *
   * The default is to allow it, because "target 1 character in this area"
   * means the source when it is the only one standing there. A card that says
   * "another" has to say so, or Griffith walks himself to where he already is.
   */
  readonly excludeSelf?: boolean;
  /**
   * How many cities away the choice may stand. Rules.md §15 "Distance" — 1 is
   * an adjacent city. Counted from the source's own area, which is therefore
   * always included, so this widens `where: 'thisArea'` rather than replacing
   * it: "this area, or an area up to 1 distance away" is `maxDistance: 1`.
   */
  readonly maxDistance?: number;
}

/**
 * Which areas an ability lets the player choose between. Rules.md §13.
 *
 * - `adjacent` — a city next to the chosen character's own (BK1-032), index
 *   ±1 along the row. A real choice anywhere but the two ends.
 * - `anyOther` — any city but the one the card stands in (BK1-068).
 * - `enemyLevel3` — any city where the opponent has a character of Level 3
 *   or more standing face up (BK1-062).
 * - `youOccupyOther` — any city its controller occupies but the one the card
 *   stands in (BK1-111, "any other area you occupy").
 * - `withinTwo` — any other city within Distance 2 of the source (BK1-131).
 *   §15 counts from the card's own area, which is excluded here because the
 *   printed line says "to *another* area".
 *
 * The choice travels in `OPEN_CARD.areas` / `USE_ABILITY.areas`, not in
 * `targets`: an area is not a card, and an ability may want either or both.
 */
export type AreaKind = 'adjacent' | 'anyOther' | 'enemyLevel3' | 'youOccupyOther' | 'withinTwo';

/** What has to be true for the ability to apply. */
export type Condition =
  /** A card of this name is face up on your side, anywhere. */
  | { readonly when: 'youControlName'; readonly name: string }
  /** This character is attacking an area its opponent occupies. Rules.md §12. */
  | { readonly when: 'attackingOccupiedArea' }
  /** This character is the vanguard of the battle it is in. Rules.md §11 ①. */
  | { readonly when: 'isVanguard' }
  /** Its controller occupies the area it stands in. */
  | { readonly when: 'youOccupyThisArea' }
  /** The other player occupies the area it stands in. */
  | { readonly when: 'enemyOccupiesThisArea' }
  /** It was opened this turn. Rules.md §7. */
  | { readonly when: 'openedThisTurn' }
  /** Its controller took the area it stands in this turn. Rules.md §12. */
  | { readonly when: 'youCapturedThisArea' }
  /** A battle was declared over its area this turn, by anyone. Rules.md §11. */
  | { readonly when: 'battleDeclaredThisArea' }
  /** No enemy character arrived in its area this turn, by move or effect. */
  | { readonly when: 'noEnemyArrivedThisArea' }
  /** An enemy character arrived in its area this turn — the other reading. */
  | { readonly when: 'enemyArrivedThisArea' }
  /**
   * A battle was declared over its area this turn by the *other* player, so
   * its controller was the one defending (BK1-147). Rules.md §11 ①.
   */
  | { readonly when: 'defendedThisArea' }
  /** Nobody holds the area it stands in. Rules.md §12. */
  | { readonly when: 'areaUnoccupied' }
  /**
   * An enemy character of at least this Level stands in its area (BK1-134).
   * Rules.md §7.
   */
  | { readonly when: 'enemyLevelHere'; readonly level: number }
  /**
   * Its controller opened a character in its area this turn (BK1-143).
   * Rules.md §7 — `OPENED_ON_TURN` is what records it.
   */
  | { readonly when: 'openedCharacterHere' }
  /**
   * The player whose card this ability is pointed at does not occupy the
   * area (BK1-113, "while they do not occupy this area"). Rules.md §12.
   *
   * Read against the *chosen* card rather than the source, which is what
   * makes it usable from an `arrival` trigger: the newcomer is the choice.
   */
  | { readonly when: 'targetDoesNotOccupyThisArea' }
  /**
   * City Level is at most this (BK1-028, BK1-033). Rules.md §5.
   *
   * The cards say "area level", which is not a term the rules define: City
   * Level is a single global value and there is no per-city one, so that is
   * what this reads.
   */
  | { readonly when: 'cityLevelAtMost'; readonly level: number }
  /** A character its controller owns arrived in its area this turn. */
  | { readonly when: 'allyArrivedThisArea' }
  /**
   * Its controller holds no cities at all and the other player holds at
   * least `enemyAtLeast` (BK1-155). Rules.md §12 — a card for the player who
   * is losing badly, so both halves are printed and both are checked.
   */
  | { readonly when: 'losingBadly'; readonly enemyAtLeast: number };

/**
 * What the ability does when it applies.
 *
 * `per` is Rules.md §13's "for each": the effect's size is multiplied by how
 * many cards that selector reaches when the ability resolves. It counts, it
 * does not reach — an effect still only lands on `who`. A `per` that matches
 * nothing therefore does nothing at all, which is the printed behaviour: "+2/+2
 * for each character your opponent controls in this area" is worth nothing
 * across an empty area.
 */
export type Effect =
  /**
   * Change numbers. Under an `always` trigger this is continuous and read
   * off the board; under any other trigger it lasts to the end of the turn
   * and is written onto the card.
   */
  | {
      readonly do: 'buff';
      readonly who: Selector;
      readonly stats: StatLine;
      readonly per?: Selector;
    }
  | {
      readonly do: 'draw';
      readonly player: EffectPlayer;
      readonly count: number;
      readonly per?: Selector;
    }
  /**
   * Cards out of a hand and into the Trash. Rules.md §13.
   *
   * Who picks follows who is losing them. `opponent` is taken at random,
   * because the printed line says "your opponent discards" and not "your
   * opponent may choose" — letting them pick their worst card is a different
   * card. `you` stops and asks, for the same reason from the other side: a
   * line reading "discard 2 cards" has named a number, not the cards.
   *
   * Asking suspends the ability — see {@link PendingChoice}. Anything in
   * `then` runs once the last card has been named, so a card that draws and
   * then discards still reads in printed order.
   */
  | {
      readonly do: 'discard';
      readonly player: EffectPlayer;
      readonly count: number;
      /**
       * Only discard while the hand is at least this big (BK1-104's "if they
       * have 3 or more cards in their hand"). A threshold, not a floor: the
       * card names one card, so a hand of exactly three loses one and stops.
       */
      readonly ifHandAtLeast?: number;
    }
  /**
   * Take cards out of your deck and shuffle. Rules.md §13.
   *
   * `named` is the printed restriction — "add 1 Serpico from your deck" — and
   * matches the card's printed *name*, so any printing of it will do;
   * `characterOnly` is "search for a character". A search that finds nothing
   * simply finds nothing; it is not an error and does not stop to ask.
   *
   * `upTo` lets the player stop short of `count`. `to` says where the cards
   * go: the hand, the Trash (BK1-075), or face down into this area as Set
   * Cards (BK1-025). `reveal` shows the opponent what was taken (BK1-065).
   */
  | {
      readonly do: 'search';
      readonly player: 'you';
      readonly count: number;
      readonly named: string | null;
      readonly characterOnly?: boolean;
      /**
       * Look in the Trash as well as the deck (BK1-115, "search your deck or
       * your graveyard"). Rules.md §14 — all Trash cards are public, so
       * nothing is revealed by offering them that both players cannot
       * already see. The deck is still shuffled afterwards.
       */
      readonly includeTrash?: boolean;
      /**
       * Only the top this-many cards are looked at (BK1-023, "look at the top
       * 5 cards … select 2"). Rules.md §13.
       *
       * `count` is still how many may be taken; this is how far down the deck
       * the player is allowed to see. The deck is *not* shuffled afterwards
       * when this is set — a card that says "look at the top n" has not
       * searched the deck, so §13's shuffle does not apply and BK1-159 says
       * so outright.
       */
      readonly topOfDeck?: number;
      readonly upTo?: boolean;
      /**
       * Where the cards go. `set` puts them face down as Set Cards (BK1-025);
       * `setOpen` sets and then opens at once, paying nothing and ignoring City
       * Level (BK1-091) — the printed line names both halves, and a card set but
       * left face down would be a different card. `setAnywhere` sets them face
       * down in whichever city the player names, one card at a time (BK1-155).
       */
      readonly to?: 'hand' | 'trash' | 'set' | 'setOpen' | 'setAnywhere';
      readonly reveal?: boolean;
    }
  /**
   * Set a character from hand into this area and open it at once, paying
   * nothing and ignoring City Level (BK1-061). Rules.md §13 — the card names
   * a Level ceiling precisely because the usual gate does not apply. Always
   * "you may": the player can decline.
   *
   * RULES: the printed line does not say whether the cost is paid. Read as
   * free — a Level 3 Quick whose whole point is putting Guts on the table.
   */
  | { readonly do: 'setFromHand'; readonly maxLevel: number | null }
  /**
   * Turn cards off the top of your deck until a character shows up, set it in
   * this area and open it; the rest go to the Trash (BK1-150). Rules.md §13.
   *
   * Nothing is chosen, so it never stops to ask — which is the whole
   * difference from `search`. `joinsBattle` is the printed tail: a character
   * that replaces one which was fighting steps into the same fight (§11 ③).
   */
  /**
   * Set the top card of your deck face down in an area (BK1-158). Rules.md
   * §7 and §13.
   *
   * Nothing is chosen and nothing is revealed: it is the top card, face
   * down, so it stays as hidden as any other Set Card. `where` says which
   * area — `chosenArea` is the one the trigger supplied, which for an
   * `enemyCapture` is the city that just changed hands.
   */
  | {
      readonly do: 'setTopOfDeck';
      readonly where: 'sourceArea' | 'chosenArea';
    }
  | {
      readonly do: 'revealUntilCharacter';
      readonly to: 'setOpen';
      readonly joinsBattle?: boolean;
    }
  /**
   * "You may …": a yes or no, and the effects that follow a yes. Rules.md
   * §13. Stops the game on the question like any other pending choice.
   */
  | { readonly do: 'may'; readonly effects: readonly Effect[] }
  /**
   * Give up this turn's Draw phase and draw `atEnd` cards at the end of the
   * turn instead (BK1-066). Only meaningful at the start of a turn, before
   * the Draw phase has run.
   */
  | { readonly do: 'skipDraw'; readonly atEnd: number }
  /**
   * Attach the source to the chosen character. Rules.md §13. The grants are
   * read off the board while both stand — see `rules.ts:continuousBonus` and
   * `rangeOf` — and the attachment leaves with its host.
   */
  | { readonly do: 'attach'; readonly who: Selector; readonly grants: Grants }
  | { readonly do: 'unlock'; readonly who: Selector }
  /**
   * Show face-down cards to a player, for the rest of the match. Rules.md
   * §13 — the printed exception to §7's "your opponent's Set Cards are
   * hidden".
   *
   * `to` is who gets to look: `you` is Sonia peeking (BK1-141), `both` is a
   * reveal that shows everybody (BK1-142). Recorded in `GameState.revealed`
   * rather than announced once, because a card turned face up for a moment
   * and then redacted again would be a reveal the player could blink and
   * miss.
   */
  | { readonly do: 'reveal'; readonly who: Selector; readonly to: 'you' | 'both' }
  /**
   * Locks a character, as an effect rather than as a cost. Rules.md §6.
   *
   * `skipRefresh` is BK1-085's second half: the target also owes that many
   * Refresh phases before it stands again. The two travel together because
   * the printed line does both for one price, and the lock is unconditional
   * — a character already locked still takes the mark.
   */
  | { readonly do: 'lock'; readonly who: Selector; readonly skipRefresh?: number }
  /**
   * The top of a deck into the Trash, unseen. Rules.md §1.
   *
   * Distinct from `search`, which looks through a player's *own* deck and
   * stops to ask which card: this takes the top `count` blind, so nothing is
   * revealed and nothing is chosen. A deck too short to pay simply gives what
   * it has — running dry is `applyDraw`'s rule and loses the match on the
   * *draw*, not here.
   */
  | { readonly do: 'mill'; readonly player: 'you' | 'opponent'; readonly count: number }
  | { readonly do: 'returnToHand'; readonly who: Selector }
  /**
   * Marks damage, exactly as a battle does — so it accumulates with combat
   * damage, kills at HP, and clears at end of turn (Rules.md §3). An effect
   * that dealt its own separate kind of damage would need all three rules
   * again, and would get one of them wrong.
   */
  | { readonly do: 'damage'; readonly who: Selector; readonly amount: number }
  /**
   * Softens damage on its way in, to a floor of nothing.
   *
   * Applied where damage *lands* rather than where it is assigned, because
   * Rules.md §11 ④ has a striker spend its Power exactly — Serpico's armour
   * makes the blow smaller, it does not let the attacker hold Power back.
   *
   * Under `always` this is continuous and read off the board; under any other
   * trigger it is written onto the card and lasts the turn, like a buff.
   * `combatOnly` is the printed distinction: Serpico reduces damage "during
   * combat", while Magical Barrier reduces damage from any source.
   */
  | {
      readonly do: 'reduceDamage';
      readonly who: Selector;
      readonly amount: number;
      readonly combatOnly?: boolean;
    }
  /** Straight to the Trash, whatever its HP. Rules.md §12. */
  | {
      readonly do: 'destroy';
      readonly who: Selector;
      /**
       * Draw one card for each card this destroyed — "destroy all eternal
       * effect cards in play, then draw that many" (BK1-152).
       *
       * Carried on the destroy rather than left to a following `draw` with a
       * `per`, because a `per` is counted when *it* runs: by then the cards
       * are in the Trash and it would always count nothing.
       */
      readonly drawPerDestroyed?: boolean;
    }
  /**
   * Puts a character somewhere else on the board.
   *
   * Not the Main-phase move of Rules.md §10 ④(1): that one is bounded by the
   * character's own Move and locks it on arrival (§6). This is a card saying
   * where somebody ends up, and §14 has a card effect take precedence over the
   * rule it contradicts — so nothing is locked and no Move is spent. How far
   * the effect may reach is the ability's own business, expressed as
   * `TargetSpec.maxDistance`.
   *
   * Two destinations so far, both named rather than assumed so a card that
   * picks an arbitrary area can be added beside them without confusion:
   *
   * - `sourceArea` — "move that character to this area", where "this" is the
   *   card doing the moving.
   * - `chosenArea` — wherever the player picked: `Ability.area` marks the
   *   ability as wanting an area (adjacent for BK1-032, any other for
   *   BK1-068, one the enemy holds a Level 3 in for BK1-062), and the
   *   destination rides in the action's `areas` alongside its chosen
   *   characters.
   */
  | {
      readonly do: 'moveTo';
      readonly who: Selector;
      readonly where: 'sourceArea' | 'chosenArea';
      /**
       * Take the ability's own card along (BK1-131, "move this **and**
       * another character"). Rules.md §13.
       *
       * A second selector would not do: the destination is chosen relative
       * to where the source is standing *now*, so it has to move with the
       * companion rather than being reached separately.
       */
      readonly withSource?: boolean;
    }
  /**
   * Rules.md §11 — may not lead or join an attack. Continuous only: it is
   * read off the board by `rules.ts:cannotAttack`.
   *
   * A character barred this way may still *defend*, which is the whole
   * difference from {@link cannotBattle} below.
   */
  | { readonly do: 'cannotAttack'; readonly who: Selector }
  /**
   * Rules.md §11 — "cannot participate in battle": it may not be chosen for
   * the fight at all, on either side, for the rest of the turn.
   *
   * Written onto the card as a counter rather than read off the board,
   * because the cards that impose it are Normal Effects and are in the Trash
   * the moment they resolve (§3). Swept with the boosts at end of turn.
   */
  | { readonly do: 'cannotBattle'; readonly who: Selector }
  /**
   * A Set Card cannot be opened for the rest of the turn (BK1-031).
   * Rules.md §7 — the gate is on opening, so `legalActions` stops offering
   * it and `openCard` refuses it.
   */
  | { readonly do: 'seal'; readonly who: Selector }
  /**
   * A bonus that only counts while its holder is defending a battle
   * (BK1-029). Rules.md §11. Lasts the turn, like a buff, and is swept with
   * the other counters.
   */
  | { readonly do: 'defenderBonus'; readonly who: Selector; readonly stats: StatLine }
  /**
   * Damage the chosen character deals to its opponent's side in this area is
   * dealt to itself instead, until end of turn (BK1-027). Rules.md §11 ④.
   *
   * Marked on the striker rather than on the protected characters, because
   * the printed line is about *that character's* blows however many people
   * it swings at.
   */
  | { readonly do: 'reflectDamage'; readonly who: Selector }
  /**
   * Remember the chosen character, so this card's continuous abilities can go
   * on applying to it (BK1-157). Rules.md §13.
   *
   * Written down because the choice was made once, when the card was opened,
   * and an Eternal has to keep answering for it — unlike a `target` selector,
   * which only reaches the chosen card while the effect is resolving.
   */
  | { readonly do: 'mark' }
  /**
   * Show yourself where the Royal Capital is (BK1-022). Rules.md §5.
   *
   * Recorded in `GameState.citiesSeen` rather than turning the city face up:
   * §5 has a city turn up only when a battle commences there, and flipping
   * it would raise City Level for both players and show the opponent too.
   */
  | { readonly do: 'seeCapital' }
  /**
   * Silence the reached cards' abilities until end of turn (BK1-151).
   * Rules.md §14.
   */
  | { readonly do: 'negate'; readonly who: Selector }
  /**
   * The marked character may not attack the area this card stands in
   * (BK1-157). Rules.md §11. Continuous: read off the board.
   */
  | { readonly do: 'markedCannotAttackHere' }
  /**
   * The marked character is destroyed if it leaves this area (BK1-157).
   * Rules.md §13. Continuous: checked where a character moves.
   */
  | { readonly do: 'markedDiesIfItLeaves' }
  /**
   * Turn a Set Card face up at once, paying nothing and outside the City
   * Level gate (BK1-030). Rules.md §7 and §13.
   *
   * Free and ungated for the same reason BK1-061's is: the printed line is
   * what puts it into play, not the turn's one open (§10 ③), which it
   * therefore does not spend either.
   */
  | { readonly do: 'openSetCard'; readonly who: Selector }
  /**
   * Look at the top `count` cards of your deck and put them back in an order
   * you choose (BK1-159). Rules.md §13.
   *
   * The player names them one at a time, and each named card goes back on
   * top — so the *last* one named ends up on top of the deck. Not a search:
   * nothing is taken and nothing is shuffled, which is what the printed line
   * says outright.
   */
  | { readonly do: 'reorderTop'; readonly count: number }
  /**
   * Shifts the City Level a player opens against (BK1-116, "can only open
   * cards as if the level were 1 lower"). Rules.md §5 and §7.
   *
   * Continuous and read off the board by `rules.ts:openLevelFor`, never
   * stored — City Level itself is unchanged, because §5 defines it as the
   * count of face-up cities and a card does not get to rewrite that. This is
   * a restriction on *opening*, which is §7's business.
   *
   * `who` says whose opens are affected, read from the source's own side.
   */
  | {
      readonly do: 'openLevel';
      readonly player: 'occupier' | 'opponent';
      readonly shift: number;
    }
  /**
   * Replaces the number of cards §12's capture pays out, while this card is
   * among the attackers (BK1-093 draws 1 instead of 2).
   *
   * Continuous and read off the board at the moment the city changes hands,
   * like the other `always` effects — there is nothing to write down and
   * nothing to undo if the Troll dies before the battle ends. Several such
   * cards in one fight take the lowest, since each is a card saying the draw
   * is smaller than the rule allows.
   */
  | { readonly do: 'captureDraw'; readonly count: number }
  /**
   * Somebody else destroys one of their own cards, of their choosing
   * (BK1-100). Rules.md §13.
   *
   * Distinct from `destroy`, which reaches whatever its selector names and
   * gives nobody a say: this hands the choice to the card's *owner*, so it
   * stops and asks them. `who` is read from the source's side as usual —
   * `side: 'theirs'` is the opponent's cards — and the player asked is
   * whoever controls what the selector reached.
   *
   * Nothing in reach is not an error: the ability resolves having done
   * nothing, like any other effect that finds nobody.
   */
  | { readonly do: 'theyDestroy'; readonly who: Selector; readonly count: number }
  /**
   * "Target any number of characters and move them to this area" (BK1-147).
   * Rules.md §13.
   *
   * Not a `target` on the ability: the wire carries one target per ability,
   * and "any number" would be a cross-product of every subset. The player
   * names them one at a time instead, and may stop whenever they like — so
   * `count` is a ceiling rather than a debt.
   *
   * `unlock` is the printed tail. Like every card-effect move this spends no
   * Move and locks nobody (§14 over §6), so the unlock is a real grant.
   */
  | {
      readonly do: 'gatherHere';
      readonly who: Selector;
      readonly count: number;
      readonly unlock?: boolean;
    }
  /**
   * A choice put to the opponent once for each character they have in the
   * battle here: lose that character, or pay `discard` cards (BK1-103).
   * Rules.md §13.
   *
   * One effect rather than a loop of smaller ones because the *number* of
   * questions is read off the board when it resolves, and each answer is
   * independent — paying for one character says nothing about the next.
   */
  | {
      readonly do: 'destroyOrDiscard';
      readonly who: Selector;
      readonly discard: number;
    }
  /**
   * The same question, carried on to the characters that have not been asked
   * about yet. Not a printed ability: BK1-103 asks once per character, and
   * this is how the remainder rides along in a {@link Continuation} while the
   * player answers for the one in front of them.
   *
   * The victims are named by instance rather than by selector because the
   * board moves between questions — a selector would re-reach whoever is
   * standing there by the time the last answer comes in.
   */
  | {
      readonly do: 'askDestroyOrDiscard';
      readonly cards: readonly CardInstanceId[];
      readonly discard: number;
    }
  /** One named card to the Trash, for the same continuation. */
  | { readonly do: 'destroyOne'; readonly card: CardInstanceId };

/**
 * When an ability does its work.
 *
 * `always` is Rules.md §13's cost-free continuous ability: it is not an event
 * at all, it is read off the board wherever the numbers are needed. The rest
 * fire once and write their result onto the game state.
 */
export type Trigger =
  | 'always'
  | 'open'
  | 'attack'
  | 'turnStart'
  | 'turnEnd'
  /** This character has been destroyed. Rules.md §3 — it fires on the way out. */
  | 'death'
  /**
   * A character arrived in this card's area — opened there, or moved there
   * (BK1-113). Rules.md §7 and §10 ④(1).
   *
   * Fires on the *arriving* card's behalf but is read off the card that owns
   * the ability, so the newcomer is what a `{ scope: 'target' }` selector
   * reaches: `fireArrival` passes it as the chosen card.
   */
  | 'arrival'
  /**
   * The other player has just captured a city (BK1-158). Rules.md §12.
   *
   * Fired from where the city changes hands, on behalf of the card that owns
   * the ability. The captured area travels as the chosen *area*, so an effect
   * can act on it rather than on wherever the card happens to stand.
   */
  | 'enemyCapture'
  /**
   * The player chose to use it and paid for it. Rules.md §13's cost-bearing
   * ability: usable only in your own Main phase unless it is Quick.
   */
  | 'activated';

/**
 * What using an ability costs. Rules.md §13 and §6.
 *
 * §13 describes the cost printed to the left of the separator, paid from hand
 * into the Trash. §6 adds the other kind the cards use: an action may "lock it
 * as a cost", which is what the printed "Tap:" asks for. Both may appear, and
 * every part must be payable or the ability is never offered.
 */
export interface ActivationCost {
  /** "Tap:" — lock the card whose ability this is. It must be unlocked. */
  readonly lockSelf?: boolean;
  /**
   * Lock a character the player picks, for a card that cannot lock itself —
   * an Eternal Effect is not a character and never stands unlocked.
   */
  readonly lockAlly?: TargetSpec;
  /** Cards out of hand into the Trash, in the DesignNotes 8 notation. */
  readonly pay?: string;
  /** "Can only be used once per turn." */
  readonly oncePerTurn?: boolean;
  /**
   * "Destroy this card:" — the source goes to the Trash to pay for its own
   * ability (BK1-092). Rules.md §13.
   *
   * Paid *before* the effect resolves, as printed, so a card that locks
   * somebody is already gone when it does — and its own `death` abilities
   * fire on the way out like any other destruction.
   */
  readonly destroySelf?: boolean;
}

export interface Ability {
  readonly trigger: Trigger;
  readonly effect: Effect;
  /**
   * Further effects of the *same* ability, resolved in printed order after
   * `effect` and sharing its cost, condition and chosen target.
   *
   * A printed line that does two things for one price is one ability, not
   * two: splitting "Return this card to your hand. Draw 2 cards." into
   * separate entries would leave the draw sitting there to be used for free.
   */
  readonly then?: readonly Effect[];
  readonly condition?: Condition;
  /**
   * The condition gates the *open* rather than the effect: "this card can
   * only be opened if …" (BK1-039, BK1-065). A card whose gate is shut is
   * never offered and is refused — the ordinary reading would let it be
   * opened and do nothing, which is a Set Card thrown away.
   */
  readonly gate?: boolean;
  /**
   * The ability asks the player to choose an area. Rules.md §13. With a
   * `target`, the area is chosen after the character (BK1-032: "move it to
   * an adjacent area"); without one, the area is the only choice (BK1-068).
   */
  readonly area?: AreaKind;
  /**
   * Whose turns a turn-edge trigger answers to, and the difference is printed
   * on the cards: Corkus says "at the start of **your** turn" and BK1-003
   * says "at the end of **the** turn". The possessive is the whole rule, so
   * it is carried here rather than assumed.
   *
   * Defaults to `yours`, the narrower reading.
   */
  readonly turns?: 'yours' | 'any';
  /**
   * Set when the ability asks the player to choose a character. The effect
   * then reaches it through a `{ scope: 'target' }` selector, and nothing
   * else — an ability with a target and no legal one simply does nothing.
   */
  readonly target?: TargetSpec;
  /** What using it costs. Only meaningful under the `activated` trigger. */
  readonly cost?: ActivationCost;
  /**
   * Rules.md §13's Quick: the ability may be used at any time rather than
   * only in its controller's Main phase. Printed on the ability, not the
   * card — BK1-045 Guts is not a Quick *card*, but his ability is Quick.
   */
  readonly quick?: boolean;
  /** The printed line this stands for. Display and review only. */
  readonly text: string;
}

/* ------------------------------------------------------- counters on a card
 *
 * Temporary effects are stored in `CardInstance.counters`, which is exactly
 * what that field is for. The boosts are cleared with damage in the End phase
 * (Rules.md §10 ⑤), so "until end of turn" needs no timer of its own.
 */

export const BOOST_POWER = 'boostPower';
export const BOOST_HP = 'boostHp';
export const BOOST_MOVE = 'boostMove';

/**
 * Damage reduction granted for the turn — "reduce damage that character
 * receives by 3 this turn". Swept with the boosts, so it needs no timer.
 *
 * Separate from the combat-only kind, which is continuous and never written
 * down: a card that says "during combat" has to be asked about each blow, and
 * a counter could not tell the two apart once it was on the card.
 */
export const SHIELD = 'shield';

/**
 * Owed skips of the next Refresh unlock — BK1-085.
 *
 * Deliberately *not* a boost: it has to survive to a future turn, so the End
 * phase must not sweep it. `applyRefresh` spends one and leaves the card
 * locked, which is why it is a count rather than a flag — two Nightmares
 * pointed at the same character cost it two Refresh phases.
 */
export const SKIP_REFRESH = 'skipRefresh';

/**
 * Barred from battle for the rest of the turn — BK1-149's "cannot
 * participate in battle". Rules.md §11.
 *
 * A counter rather than a continuous reading, because the printed line is
 * "until end of turn" and its source is a Normal Effect that goes to the
 * Trash the moment it resolves: there would be nothing left on the board to
 * read it off. Swept with the boosts, so it needs no timer.
 */
export const NO_BATTLE = 'noBattle';

/**
 * A Set Card barred from being opened for the rest of the turn (BK1-031).
 * Rules.md §7.
 *
 * Swept with the boosts, so "this turn" needs no timer of its own.
 */
export const SEALED = 'sealed';

/**
 * An extra +1/+1 that applies only while its holder is defending a battle
 * (BK1-029's "while defending it gains an additional +1/+1"). Rules.md §11.
 *
 * A plain boost counter cannot express this: the bonus comes and goes with
 * the fight, and the card that granted it is a Normal Effect already in the
 * Trash (§3), so there is nothing on the board to read it off either. Held
 * as a count of how many such grants are outstanding and paid out by
 * `powerOf`/`hpOf` only when a battle is actually running.
 */
export const REARGUARD = 'rearguard';

/**
 * Damage this character deals to the *marker's* side comes back at it
 * instead (BK1-027). Rules.md §11 ④.
 *
 * Held on the character whose blows are turned around, together with the
 * controller it must not hurt — a reflection that caught everybody would
 * also stop it striking its own allies, which the printed line does not say.
 * Swept with the boosts, so "until end of turn" needs no timer.
 */
export const REFLECT = 'reflect';

/**
 * This card's abilities are negated for the rest of the turn (BK1-151).
 * Rules.md §14 — "make a specified thing stop affecting the game".
 *
 * Swept with the boosts, so "until end of turn" needs no timer. Read by
 * `rules.ts:abilitiesOf`, which every ability lookup goes through — a
 * negation applied at some of them and not others would be silently wrong
 * exactly where it was forgotten.
 */
export const NEGATED = 'negated';

export const BOOST_COUNTERS: readonly string[] = [
  BOOST_POWER,
  BOOST_HP,
  BOOST_MOVE,
  SHIELD,
  NO_BATTLE,
  SEALED,
  REARGUARD,
  REFLECT,
  NEGATED,
];

const COUNTER_FOR: Readonly<Record<keyof StatLine, string>> = {
  power: BOOST_POWER,
  hp: BOOST_HP,
  move: BOOST_MOVE,
};

export const counterFor = (stat: keyof StatLine): string => COUNTER_FOR[stat];

/**
 * Which turn an ability was last used on, for "once per turn".
 *
 * Keyed by the ability's position on its card, so a card with two of them
 * tracks each separately. Not a boost, so it is not swept at end of turn —
 * it is compared against the turn number instead, which needs no clearing and
 * cannot be left stale by a card that leaves the field and comes back.
 */
export const usedOnTurnCounter = (index: number): string => `usedOnTurn:${index}`;

/**
 * How the wire names one ability of a card: its position in the printed list.
 *
 * The list is static card data, so the index is stable — and it stays correct
 * for a card carrying several abilities of different triggers, which a name
 * or a trigger alone would not distinguish.
 */
export const abilityKey = (index: number): string => String(index);

/* --------------------------------------------------------- the card entries */

const HAWK = 'hawk';

/**
 * Card id -> what it does.
 *
 * Only cards whose behaviour is fully expressible here appear. A card left
 * out keeps its printed text and does nothing, which is honest; a card given
 * an approximation of its text would be a rules bug that looks like a
 * feature. `Docs/CardData.md` lists what is still outstanding and why.
 */
const ABILITIES: Readonly<Record<string, readonly Ability[]>> = {
  'BK1-002': [
    {
      trigger: 'attack',
      condition: { when: 'attackingOccupiedArea' },
      effect: { do: 'buff', who: { scope: 'self' }, stats: { power: 1, hp: 1 } },
      text: 'When this character attacks an occupied city, it gains +1/+1 until end of turn.',
    },
  ],
  'BK1-003': [
    {
      trigger: 'turnEnd',
      // "The" turn, not "your" turn: it goes home at the end of whichever
      // turn it was brought into play, including the opponent's — a defender
      // may open during a battle on the attacker's turn (Rules.md §11 ②).
      turns: 'any',
      effect: { do: 'returnToHand', who: { scope: 'self' } },
      text: 'Return this card to your hand at the end of the turn. (Mandatory)',
    },
  ],
  'BK1-004': [
    {
      trigger: 'open',
      target: { where: 'thisArea' },
      effect: { do: 'buff', who: { scope: 'target' }, stats: { power: 1, hp: 1 } },
      text: 'When this card is opened, target 1 character in this area and it gains +1/+1 until end of turn.',
    },
  ],
  'BK1-009': [
    {
      trigger: 'activated',
      // "1:" — one card out of hand, any colour. DesignNotes 8 notation.
      cost: { pay: '1' },
      // "another", so he cannot call himself; "within 3 spaces" is Distance
      // counted from his own area, which is therefore included (Rules.md §15)
      // — a Hawk standing beside him is a legal choice that simply does not
      // move, so `moveTo` leaves it where it is.
      target: {
        side: 'yours',
        subtype: HAWK,
        where: 'anywhere',
        maxDistance: 3,
        excludeSelf: true,
      },
      effect: { do: 'moveTo', who: { scope: 'target' }, where: 'sourceArea' },
      text: '1: Target another character with the "Hawk" subtype that you control, within 3 spaces. Move that character to this area.',
    },
  ],
  'BK1-010': [
    {
      trigger: 'always',
      effect: {
        do: 'buff',
        who: { scope: 'others', side: 'yours', where: 'thisArea', subtype: HAWK },
        stats: { power: 1, hp: 1 },
      },
      text: 'Other "Hawk" type characters you own in this area gain +1/+1',
    },
  ],
  'BK1-012': [
    {
      trigger: 'attack',
      condition: { when: 'isVanguard' },
      effect: { do: 'buff', who: { scope: 'self' }, stats: { power: 1, hp: 1 } },
      text: 'When this character attacks, if it is the vanguard, it receives +1/+1 until end of turn.',
    },
  ],
  'BK1-013': [
    {
      trigger: 'activated',
      quick: true,
      // The printed "Tap:" — §6 allows a card to lock itself as a cost.
      cost: { lockSelf: true },
      // "Target white character in this area" reaches either side: the line
      // names a colour and an area and says nothing about whose it is.
      target: { where: 'thisArea', colour: 'white' },
      effect: { do: 'buff', who: { scope: 'target' }, stats: { power: 1, hp: 1 } },
      text: '(Quick) Tap: Target white (color) character in this area gains +1/+1 until end of turn.',
    },
  ],
  'BK1-014': [
    {
      trigger: 'always',
      condition: { when: 'youControlName', name: 'Griffith' },
      effect: { do: 'buff', who: { scope: 'self' }, stats: { power: 1, hp: 1, move: 1 } },
      text: 'If you control a card named "Griffith", this character gains +1/+1 and +1 Movement.',
    },
  ],
  'BK1-017': [
    {
      trigger: 'open',
      effect: { do: 'discard', player: 'opponent', count: 1 },
      text: 'When this card is opened, you opponent discards 1 card.',
    },
  ],
  'BK1-018': [
    {
      trigger: 'turnStart',
      condition: { when: 'youOccupyThisArea' },
      effect: { do: 'draw', player: 'you', count: 1 },
      text: 'At the start of your turn, if you occupy the area this card is in, draw one card.',
    },
  ],
  'BK1-020': [
    {
      trigger: 'always',
      condition: { when: 'openedThisTurn' },
      effect: { do: 'cannotAttack', who: { scope: 'self' } },
      text: 'This character cannot attack the turn its opened.',
    },
  ],
  'BK1-024': [
    {
      trigger: 'open',
      effect: { do: 'draw', player: 'you', count: 1 },
      // One printed line, one ability: the discard rides in `then`, so the
      // card is announced once and the two halves resolve in printed order.
      then: [{ do: 'discard', player: 'opponent', count: 1 }],
      text: 'When this card is opened, draw 1 card and your opponent discards 1 card.',
    },
  ],
  'BK1-026': [
    {
      trigger: 'open',
      target: { where: 'thisArea' },
      effect: { do: 'buff', who: { scope: 'target' }, stats: { power: 1, hp: 1 } },
      text: 'Target character in this area gains +1/+1 until end of turn',
    },
  ],
  'BK1-032': [
    {
      trigger: 'open',
      // "an enemy character that is level 2 or less in this area" — three
      // narrowings, all printed, plus the area the effect sends it to.
      target: { side: 'theirs', where: 'thisArea', maxLevel: 2 },
      area: 'adjacent',
      effect: { do: 'moveTo', who: { scope: 'target' }, where: 'chosenArea' },
      // One printed line, one ability: the draw rides in `then` so it cannot
      // be taken without the move.
      then: [{ do: 'draw', player: 'you', count: 1 }],
      text: 'When this card is opened, target an enemy character that is level 2 or less in this area. Move it to an adjacent area, then draw 1 card.',
    },
  ],
  'BK1-040': [
    {
      trigger: 'open',
      target: { where: 'thisArea' },
      effect: { do: 'buff', who: { scope: 'target' }, stats: { power: 2, hp: 2 } },
      text: 'When this card is opened, target character in this area gains +2/+2 until end of turn.',
    },
  ],
  /* --------------------------------------------------------------- green */

  'BK1-043': [
    {
      trigger: 'death',
      effect: { do: 'draw', player: 'you', count: 1 },
      text: 'When this character dies, draw 1 card.',
    },
  ],
  'BK1-044': [
    {
      trigger: 'activated',
      cost: { lockSelf: true },
      target: { where: 'thisArea' },
      effect: { do: 'damage', who: { scope: 'target' }, amount: 4 },
      text: 'Tap: Deal 4 damage to target character in this area.',
    },
  ],
  'BK1-045': [
    {
      trigger: 'activated',
      quick: true,
      cost: { pay: 'G', oncePerTurn: true },
      effect: { do: 'buff', who: { scope: 'self' }, stats: { power: 2, hp: 2 } },
      text: '(Quick) G: This character receives +2/+2 until the end of the turn. Can only be used once per turn.',
    },
  ],
  'BK1-046': [
    {
      trigger: 'activated',
      quick: true,
      cost: { lockSelf: true },
      // "Currently in combat" is the whole restriction: it reaches either
      // side, and only while a battle is actually running in this area.
      target: { where: 'thisArea', inCombat: true },
      effect: { do: 'damage', who: { scope: 'target' }, amount: 3 },
      text: '(Quick) Tap: Target character currently in combat in this area takes 3 damage.',
    },
  ],
  'BK1-047': [
    {
      trigger: 'open',
      effect: { do: 'draw', player: 'you', count: 3 },
      // One printed line, one ability: "draw 3, then discard 2" is a single
      // sentence with a single price, so the discard rides in `then` rather
      // than standing as an entry the player could use on its own.
      //
      // The discard stops and asks — see `PendingChoice`. It is the last thing
      // on the line, which is what makes that safe: nothing is left waiting
      // behind the question.
      then: [{ do: 'discard', player: 'you', count: 2 }],
      text: 'When this card is opened, draw 3 cards, then discard 2 cards.',
    },
  ],
  'BK1-048': [
    {
      trigger: 'activated',
      quick: true,
      cost: { pay: '1' },
      effect: { do: 'returnToHand', who: { scope: 'self' } },
      // One cost, two things done, in the printed order. A second entry would
      // be a second ability the player could use for nothing.
      then: [{ do: 'draw', player: 'you', count: 2 }],
      text: '(Quick) 1: Return this card to your hand. Draw 2 cards.',
    },
  ],
  'BK1-049': [
    {
      trigger: 'open',
      effect: { do: 'draw', player: 'you', count: 2 },
      text: 'When this card is opened, draw 2 cards.',
    },
  ],
  'BK1-050': [
    {
      trigger: 'open',
      // "1 Serpico" by printed name, so any Serpico in the deck will do.
      effect: { do: 'search', player: 'you', count: 1, named: 'Serpico' },
      text: 'When this card is opened, add 1 Serpico from your deck to your hand.',
    },
  ],
  'BK1-053': [
    {
      trigger: 'open',
      effect: {
        do: 'damage',
        who: { scope: 'any', side: 'theirs', where: 'thisArea' },
        amount: 4,
      },
      text: 'When this card is opened, deal 4 damage to each enemy character in this area.',
    },
  ],
  'BK1-057': [
    {
      trigger: 'open',
      // The same line as BK1-050, printed with "card" in it. Matched by name,
      // so both find any Serpico the deck is holding.
      effect: { do: 'search', player: 'you', count: 1, named: 'Serpico' },
      text: 'When this card is opened, add 1 Serpico card from your deck to your hand.',
    },
  ],
  'BK1-058': [
    {
      trigger: 'always',
      effect: {
        do: 'buff',
        who: { scope: 'any', side: 'yours', where: 'thisArea' },
        stats: { hp: 2 },
      },
      text: 'All characters you control in this area gain +0/+2 and your opponents characters here gain -2/+0',
    },
    {
      trigger: 'always',
      effect: {
        do: 'buff',
        who: { scope: 'any', side: 'theirs', where: 'thisArea' },
        stats: { power: -2 },
      },
      text: 'All characters you control in this area gain +0/+2 and your opponents characters here gain -2/+0',
    },
  ],
  'BK1-054': [
    {
      trigger: 'activated',
      cost: { lockSelf: true },
      effect: { do: 'draw', player: 'you', count: 2 },
      text: 'Tap: Draw 2 cards',
    },
  ],
  'BK1-055': [
    {
      trigger: 'activated',
      cost: { lockSelf: true },
      target: { where: 'thisArea' },
      effect: { do: 'damage', who: { scope: 'target' }, amount: 1 },
      text: 'Tap: Deal 1 damage to target character in this area',
    },
  ],
  'BK1-056': [
    {
      trigger: 'activated',
      cost: { lockSelf: true },
      effect: { do: 'draw', player: 'you', count: 1 },
      text: 'Tap: Draw 1 card',
    },
  ],
  // Both Serpicos carry the same printed line, and both are continuous: he is
  // armoured for as long as he is standing there, so it is read off the board
  // rather than written down.
  'BK1-051': [
    {
      trigger: 'always',
      effect: { do: 'reduceDamage', who: { scope: 'self' }, amount: 3, combatOnly: true },
      text: 'During combat reduce damage dealt to this card by 3.',
    },
  ],
  'BK1-052': [
    {
      trigger: 'always',
      effect: { do: 'reduceDamage', who: { scope: 'self' }, amount: 3, combatOnly: true },
      text: 'During combat reduce damage dealt to this card by 3.',
    },
  ],
  'BK1-059': [
    {
      trigger: 'open',
      effect: {
        do: 'buff',
        who: { scope: 'any', side: 'yours', where: 'thisArea' },
        stats: { power: 2, hp: 2 },
      },
      text: 'All characters you control in this area gain +2/+2 until end of turn.',
    },
  ],
  'BK1-060': [
    {
      trigger: 'open',
      target: { where: 'thisArea' },
      effect: {
        do: 'buff',
        who: { scope: 'target' },
        stats: { power: 2, hp: 2 },
        // The chosen character is not counted, whichever side it is on: the
        // line counts your opponent's characters here, and that is all.
        per: { scope: 'any', side: 'theirs', where: 'thisArea' },
      },
      text: 'Target 1 character in this area. It gains +2/+2 for each character your opponent controls in this area.',
    },
  ],
  'BK1-063': [
    {
      trigger: 'open',
      target: { where: 'thisArea' },
      effect: { do: 'buff', who: { scope: 'target' }, stats: { power: 4, hp: 4 } },
      text: 'Target character in this area gains +4/+4 until end of turn',
    },
  ],
  'BK1-064': [
    {
      trigger: 'open',
      // "In this area, or an area up to 1 distance away" — the source's own
      // city is distance 0, so `maxDistance` already covers "this area".
      target: { maxDistance: 1 },
      effect: { do: 'reduceDamage', who: { scope: 'target' }, amount: 3 },
      text: 'When this card is opened, target a character in this area, or an area up to 1 distance away. Reduce damage that character receives by 3 this turn.',
    },
  ],
  // "Destroy all set cards you control in all areas. Draw that many."
  //
  // Counted before they are destroyed, which is what "that many" means, so the
  // draw is written first — a `per` selector reads the board as it finds it,
  // and after the destruction there would be nothing left to count. This card
  // is face up while it resolves, so it never sweeps itself up.
  'BK1-067': [
    {
      trigger: 'open',
      effect: {
        do: 'draw',
        player: 'you',
        count: 1,
        per: { scope: 'any', side: 'yours', where: 'anywhere', faceDown: true },
      },
      // One printed line, one ability: the destruction rides in `then`.
      then: [
        {
          do: 'destroy',
          who: { scope: 'any', side: 'yours', where: 'anywhere', faceDown: true },
        },
      ],
      text: 'When this card is opened, destroy all set cards you control in all areas. Draw that many cards.',
    },
  ],
  'BK1-069': [
    {
      trigger: 'open',
      // "any card" — an unrestricted search, which is what `named: null` is.
      effect: { do: 'search', player: 'you', count: 1, named: null },
      text: 'When this card is opened, search your deck for any card and add it to your hand.',
    },
  ],
  'BK1-070': [
    {
      trigger: 'open',
      effect: { do: 'draw', player: 'you', count: 3 },
      text: 'When this card is opened, draw 3 cards',
    },
  ],
  'BK1-072': [
    {
      trigger: 'open',
      effect: {
        do: 'damage',
        who: { scope: 'any', side: 'theirs', where: 'thisArea', maxLevel: 2 },
        amount: 3,
      },
      text: 'When this card is opened, all enemy characters level 2 or lower in this area take 3 damage.',
    },
  ],
  'BK1-071': [
    {
      trigger: 'open',
      target: { maxDistance: 1 },
      effect: { do: 'reduceDamage', who: { scope: 'target' }, amount: 2 },
      text: 'When this card is opened, target a character in an area up to 1 distance away and reduce damage that would be dealt to that character by 2.',
    },
  ],
  'BK1-073': [
    {
      trigger: 'open',
      effect: {
        do: 'draw',
        player: 'you',
        count: 1,
        // "Characters you have open" — anywhere on the board, not just here.
        per: { scope: 'any', side: 'yours', where: 'anywhere' },
      },
      text: 'When this card is opened, draw cards equal to the number of characters you have open.',
    },
  ],
  'BK1-074': [
    {
      trigger: 'open',
      effect: { do: 'draw', player: 'you', count: 3 },
      text: 'When this card is opened, draw 3 cards.',
    },
    {
      trigger: 'always',
      effect: {
        do: 'buff',
        who: { scope: 'any', side: 'yours', where: 'thisArea' },
        stats: { hp: 1 },
      },
      text: 'As long as this card is on the board, your characters in this area gain +0/+1 and enemy characters gain -1/+0',
    },
    {
      trigger: 'always',
      effect: {
        do: 'buff',
        who: { scope: 'any', side: 'theirs', where: 'thisArea' },
        stats: { power: -1 },
      },
      text: 'As long as this card is on the board, your characters in this area gain +0/+1 and enemy characters gain -1/+0',
    },
  ],
  'BK1-079': [
    {
      trigger: 'open',
      effect: { do: 'draw', player: 'you', count: 3 },
      text: 'When this card is opened, draw 3 cards.',
    },
    {
      trigger: 'activated',
      quick: true,
      // An Eternal Effect is not a character and never stands unlocked, so it
      // cannot pay a "Tap:" — the printed cost is a character it controls.
      cost: { lockAlly: { side: 'yours', where: 'thisArea', unlocked: true } },
      effect: {
        do: 'buff',
        who: { scope: 'any', side: 'yours', where: 'thisArea' },
        stats: { power: 2, hp: 1 },
      },
      text: '(Quick) Lock a character you control in this area: All characters you control in this area gain +2/+1 until end of turn',
    },
  ],
  'BK1-078': [
    {
      trigger: 'open',
      effect: {
        do: 'buff',
        who: { scope: 'any', side: 'yours', where: 'thisArea' },
        stats: { power: 1, hp: 1 },
        // Reaches this area; counts the whole board. The two selectors differ
        // because the printed line does: "all characters you control in this
        // area" gain "+1/+1 for each character you have open".
        per: { scope: 'any', side: 'yours', where: 'anywhere' },
      },
      text: 'When this card is opened, all characters you control in this area gain +1/+1 for each character you have open, until end of turn.',
    },
  ],
  'BK1-080': [
    {
      trigger: 'open',
      target: { where: 'thisArea', colour: 'black' },
      effect: { do: 'destroy', who: { scope: 'target' } },
      text: 'When this card is opened, destroy 1 black character in this area.',
    },
  ],

  'BK1-025': [
    {
      trigger: 'open',
      // "Up to 2": a ceiling, so the player may stop after one or none. Found
      // cards go face down into this area as Set Cards.
      effect: { do: 'search', player: 'you', count: 2, upTo: true, named: 'Mercenary', to: 'set' },
      text: 'Search your deck for up to 2 cards named Mercenary and set them in this area.',
    },
  ],
  'BK1-039': [
    {
      trigger: 'open',
      // The condition gates the open itself: a card that "can only be opened
      // if" is never offered otherwise.
      condition: { when: 'youCapturedThisArea' },
      gate: true,
      effect: { do: 'search', player: 'you', count: 3, upTo: true, named: 'Mercenary', to: 'set' },
      text: 'This card can only be opened if you captured this area this turn. Search your deck for up to 3 Mercenary cards and set them in this area.',
    },
  ],
  'BK1-061': [
    {
      trigger: 'open',
      condition: { when: 'noEnemyArrivedThisArea' },
      // "You may": the choice stops to ask, and finishing with nothing set
      // is a legal answer.
      effect: { do: 'setFromHand', maxLevel: 4 },
      text: 'When this card is opened, if an opponent did not move a character to this area this turn, you may set 1 level 4 or lower character from your hand in this area, and immediately open it.',
    },
  ],
  'BK1-062': [
    {
      trigger: 'open',
      target: { side: 'yours', where: 'thisArea' },
      area: 'enemyLevel3',
      effect: { do: 'moveTo', who: { scope: 'target' }, where: 'chosenArea' },
      text: 'Move 1 character you control from this area to any area that an opponent has a character of level 3 or higher in.',
    },
  ],
  'BK1-065': [
    {
      trigger: 'open',
      condition: { when: 'battleDeclaredThisArea' },
      gate: true,
      effect: {
        do: 'search',
        player: 'you',
        count: 1,
        named: null,
        characterOnly: true,
        to: 'hand',
        reveal: true,
      },
      // The draw waits for the search to be answered — see `Continuation`.
      then: [{ do: 'draw', player: 'you', count: 1 }],
      text: 'Open this card only if a battle was declared in this area this turn by either player. Search your deck for a character, reveal it, and add it to your hand. Then draw 1 card.',
    },
  ],
  'BK1-066': [
    {
      trigger: 'open',
      effect: { do: 'draw', player: 'you', count: 2 },
      text: 'When this card is opened, draw 2 cards. At the start of your turn, you may choose to skip your draw phase and if you do, draw 2 cards at the end of your turn instead.',
    },
    {
      trigger: 'turnStart',
      // Asked before the Draw phase runs — `beginTurn` fires this trigger
      // and then stops on the question.
      effect: { do: 'may', effects: [{ do: 'skipDraw', atEnd: 2 }] },
      text: 'When this card is opened, draw 2 cards. At the start of your turn, you may choose to skip your draw phase and if you do, draw 2 cards at the end of your turn instead.',
    },
  ],
  'BK1-068': [
    {
      trigger: 'open',
      // No character to point at: the area is the whole choice.
      area: 'anyOther',
      effect: {
        do: 'moveTo',
        who: { scope: 'any', side: 'yours', where: 'thisArea', faceDown: true },
        where: 'chosenArea',
      },
      text: 'When this card is opened, move all your set cards from this area to any other area.',
    },
  ],
  'BK1-075': [
    {
      trigger: 'open',
      effect: { do: 'search', player: 'you', count: 3, named: null, to: 'trash' },
      then: [{ do: 'draw', player: 'you', count: 2 }],
      text: 'When this card is opened, choose 3 cards from your deck and send them to the graveyard. Then draw 2 cards.',
    },
  ],
  'BK1-076': [
    {
      trigger: 'open',
      // "A character" — either side's, as printed.
      target: { where: 'anywhere' },
      effect: { do: 'attach', who: { scope: 'target' }, grants: { power: 3, range: 1 } },
      text: 'When this card is opened, attach it to a character. That character gains +1 Range and +3 Power as long as this card remains in play',
    },
  ],
  'BK1-077': [
    {
      trigger: 'open',
      target: { where: 'anywhere' },
      effect: { do: 'attach', who: { scope: 'target' }, grants: { power: 2, hp: 4, move: 1 } },
      text: 'When this card is opened, attach it to a character. That character gains +1 Move and +2/+4 as long as this card remains in play',
    },
  ],

  /* --------------------------------------------------------------- black */

  'BK1-082': [
    {
      trigger: 'death',
      // "All characters in this area" — both sides, and the source is already
      // on its way out, so `others` rather than `any`: a card cannot be hit
      // by its own death rattle. Rules.md §3 fires this before it leaves.
      effect: { do: 'damage', who: { scope: 'others', side: 'any', where: 'thisArea' }, amount: 1 },
      text: 'When this card is destroyed, all characters in this area take 1 damage.',
    },
  ],
  'BK1-083': [
    {
      trigger: 'death',
      effect: { do: 'damage', who: { scope: 'others', side: 'any', where: 'thisArea' }, amount: 2 },
      text: 'When this card is destroyed, all characters in this area take 2 damage.',
    },
  ],
  'BK1-084': [
    {
      trigger: 'always',
      condition: { when: 'youOccupyThisArea' },
      effect: { do: 'buff', who: { scope: 'self' }, stats: { hp: 2 } },
      text: 'If you occupy the area this card is in it recieves +0/+2',
    },
  ],
  'BK1-085': [
    {
      trigger: 'always',
      effect: { do: 'cannotAttack', who: { scope: 'self' } },
      text: 'This card cannot attack.',
    },
    {
      trigger: 'activated',
      cost: { lockSelf: true },
      // "Any character in this area" — either side's, as printed.
      target: { where: 'thisArea' },
      // Locks it if it is standing, and marks it either way: the skip is owed
      // regardless of whether it was already down when this was pointed at it.
      effect: { do: 'lock', who: { scope: 'target' }, skipRefresh: 1 },
      text: 'Tap: Target any character in this area, that character does not unlock during its controllers next refresh phase.',
    },
  ],
  'BK1-086': [
    {
      trigger: 'death',
      effect: { do: 'discard', player: 'opponent', count: 1 },
      text: 'When this card is destroyed, Your opponent discards 1 card at random.',
    },
  ],
  'BK1-089': [
    {
      trigger: 'always',
      effect: { do: 'cannotAttack', who: { scope: 'self' } },
      text: 'This character cannot attack.',
    },
    {
      trigger: 'activated',
      quick: true,
      cost: { lockSelf: true },
      effect: { do: 'mill', player: 'opponent', count: 2 },
      text: '(Quick) Tap: Your opponent puts the top 2 cards of their deck into the graveyard.',
    },
  ],
  'BK1-090': [
    {
      trigger: 'always',
      effect: { do: 'cannotAttack', who: { scope: 'self' } },
      text: 'This character cannot attack.',
    },
    {
      trigger: 'activated',
      quick: true,
      cost: { lockSelf: true },
      // Printed +2/-2: the HP drop is a buff with a negative, not damage —
      // it is swept at end of turn rather than accumulating (Rules.md §10 ⑤).
      effect: { do: 'buff', who: { scope: 'self' }, stats: { power: 2, hp: -2 } },
      text: '(Quick) Tap: This card gains +2/-2 until end of turn.',
    },
  ],
  'BK1-091': [
    {
      trigger: 'death',
      // "You may (optional)" — the search is declinable, and a deck with no
      // Snowman left simply finds nothing rather than asking.
      effect: {
        do: 'may',
        effects: [
          {
            do: 'search',
            player: 'you',
            count: 1,
            named: 'Snowman',
            to: 'setOpen',
          },
        ],
      },
      text: 'When this card is destroyed, you may (optional) search your deck for a card named Snowman, set that card in this area, and then open it. Then shuffle your deck.',
    },
  ],
  'BK1-092': [
    {
      trigger: 'activated',
      quick: true,
      // "Destroy this card:" — paid on resolution, so §14's stack does not
      // fizzle the ability as a source that has gone. See `ActivationCost`.
      cost: { destroySelf: true },
      // The lock outlives the card that paid for it.
      target: { where: 'thisArea' },
      effect: { do: 'lock', who: { scope: 'target' } },
      text: '(Quick) Destroy this card: Lock 1 character in this area.',
    },
  ],
  'BK1-093': [
    {
      trigger: 'always',
      effect: { do: 'captureDraw', count: 1 },
      text: 'When you capture an area while attacking with this card, you draw 1 card instead of 2.',
    },
  ],
  'BK1-094': [
    {
      trigger: 'death',
      // "Discard a card of your choice" — your own hand, so it stops and asks.
      effect: { do: 'discard', player: 'you', count: 1 },
      text: 'When this card is destroyed, discard a card of your choice.',
    },
  ],
  'BK1-097': [
    {
      trigger: 'activated',
      quick: true,
      cost: { pay: 'B' },
      effect: { do: 'buff', who: { scope: 'self' }, stats: { power: 2, hp: 1 } },
      text: '(Quick) B: This card gains +2/+1 until end of turn',
    },
  ],
  'BK1-098': [
    {
      trigger: 'activated',
      cost: { lockSelf: true },
      // "Level 1 or level 0" is a ceiling, which the selector already spells.
      target: { where: 'thisArea', maxLevel: 1 },
      effect: { do: 'damage', who: { scope: 'target' }, amount: 2 },
      text: 'Tap: Target character in this area that is level 1 or level 0 takes 2 damage.',
    },
  ],
  'BK1-099': [
    {
      trigger: 'activated',
      cost: { lockSelf: true },
      effect: { do: 'mill', player: 'opponent', count: 3 },
      text: 'Tap: Your opponent puts the top 3 cards of their deck into the graveyard',
    },
  ],
  'BK1-100': [
    {
      trigger: 'activated',
      cost: { lockSelf: true },
      condition: { when: 'youOccupyThisArea' },
      // "In this area, or an adjacent area of their choice": Distance 1 from
      // this card, which §15 counts from its own area — so this one included.
      // The opponent picks which, hence `theyDestroy` rather than `destroy`.
      effect: {
        do: 'theyDestroy',
        who: { scope: 'any', side: 'theirs', faceDown: true, maxDistance: 1 },
        count: 1,
      },
      text: 'Tap: If this character is in an occupied area you control, your opponent destroys 1 set card they control in this area, or an adjacent area of their choice.',
    },
  ],
  'BK1-101': [
    {
      trigger: 'activated',
      cost: { pay: '1B' },
      // The card moves itself, so the area is the only thing to choose.
      area: 'adjacent',
      effect: { do: 'moveTo', who: { scope: 'self' }, where: 'chosenArea' },
      text: '1B: Move this card to an adjacent area',
    },
  ],
  'BK1-102': [
    {
      trigger: 'activated',
      cost: { pay: '1B' },
      effect: { do: 'unlock', who: { scope: 'self' } },
      text: '1B: Unlock this card',
    },
  ],
  'BK1-103': [
    {
      trigger: 'open',
      // Per character they have in the fight here: pay 2, or lose it. §11 ③
      // is what "in battle" means, so with no battle on this reaches nobody.
      effect: {
        do: 'destroyOrDiscard',
        who: { scope: 'any', side: 'theirs', where: 'thisArea', inCombat: true },
        discard: 2,
      },
      text: 'When this card is opened, your opponent must discard 2 cards for each character they control in battle in this area or destroy that card',
    },
  ],
  'BK1-104': [
    {
      trigger: 'open',
      effect: { do: 'draw', player: 'you', count: 2 },
      text: 'When this card is opened, draw 2 cards.',
    },
    {
      trigger: 'turnStart',
      // "Each player's turn", and it hits whoever holds the area — which may
      // be its own controller. Both halves are printed, so both are said.
      turns: 'any',
      effect: { do: 'discard', player: 'occupier', count: 1, ifHandAtLeast: 3 },
      text: 'At the start of each players turn, if that player occupies this area, they must discard a card if they have 3 or more cards in their hand.',
    },
  ],
  'BK1-105': [
    {
      trigger: 'open',
      // "All characters in this area", both sides. The card is an Effect and
      // never stands in the area as a character, so nothing excludes itself.
      effect: { do: 'destroy', who: { scope: 'any', side: 'any', where: 'thisArea' } },
      text: 'Destroy all characters in this area.',
    },
  ],

  'BK1-106': [
    {
      trigger: 'open',
      // "This area, or an adjacent area" is Distance 1, counted from the
      // card's own city, which is therefore included (§15).
      target: { maxDistance: 1 },
      effect: { do: 'damage', who: { scope: 'target' }, amount: 2 },
      text: 'When this card is opened, target a character in this area, or an adjacent area, and deal 2 damage to it',
    },
  ],
  'BK1-109': [
    {
      trigger: 'open',
      target: { side: 'yours', where: 'thisArea' },
      // One printed line doing two things for one price: one ability with a
      // `then`, never two entries.
      effect: { do: 'unlock', who: { scope: 'target' } },
      then: [{ do: 'damage', who: { scope: 'target' }, amount: 2 }],
      text: 'When this card Is opened, target 1 character you control in this area, unlock it, and deal 2 damage to it.',
    },
  ],
  'BK1-117': [
    {
      trigger: 'open',
      effect: { do: 'discard', player: 'opponent', count: 3 },
      text: 'When this card is opened your opponent discards 3 cards.',
    },
  ],
  'BK1-118': [
    {
      trigger: 'open',
      target: { where: 'thisArea', maxLevel: 1 },
      effect: { do: 'destroy', who: { scope: 'target' } },
      text: 'When this card is opened, destroy a level 1 or lower character in this area.',
    },
  ],
  'BK1-119': [
    {
      trigger: 'open',
      target: { where: 'thisArea' },
      effect: { do: 'damage', who: { scope: 'target' }, amount: 2 },
      text: 'When this card is opened, deal 2 damage to target character in this area.',
    },
  ],
  'BK1-120': [
    {
      trigger: 'open',
      // "Can only be opened if" — a gate, so it is never offered otherwise
      // rather than being opened to do nothing.
      gate: true,
      condition: { when: 'battleDeclaredThisArea' },
      effect: { do: 'discard', player: 'opponent', count: 2 },
      text: 'This card can only be opened if a battle was declared in this area this turn. Your opponent discards 2 cards.',
    },
  ],

  /* ----------------------------------------------------------------- red */

  'BK1-126': [
    {
      trigger: 'open',
      effect: { do: 'buff', who: { scope: 'self' }, stats: { power: 1, hp: 1 } },
      text: 'When this card is opened, it gets +1/+1 until the end of the turn.',
    },
  ],
  'BK1-127': [
    {
      trigger: 'open',
      effect: { do: 'buff', who: { scope: 'self' }, stats: { power: -1, hp: -1 } },
      text: 'When this card is opened it gets -1/-1 until end of turn.',
    },
  ],
  'BK1-132': [
    {
      trigger: 'activated',
      quick: true,
      cost: { lockSelf: true },
      // "All characters in this area" — both sides, Zodd included.
      effect: {
        do: 'buff',
        who: { scope: 'any', side: 'any', where: 'thisArea' },
        stats: { power: -2 },
      },
      text: '(Quick) Tap: All characters in this area get -2/+0 until end of the turn',
    },
  ],
  'BK1-133': [
    {
      trigger: 'activated',
      quick: true,
      cost: { pay: '1R' },
      target: { where: 'thisArea' },
      effect: { do: 'damage', who: { scope: 'target' }, amount: 2 },
      text: '(Quick) 1R: Target character in this area takes 2 damage.',
    },
  ],
  'BK1-135': [
    {
      trigger: 'always',
      // "All cavalry characters you control" — the whole board, not just here.
      effect: {
        do: 'buff',
        who: { scope: 'any', side: 'yours', where: 'anywhere', subtype: 'cavalry' },
        stats: { power: 1, hp: 1 },
      },
      text: 'All cavalry characters you control get +1/+1',
    },
  ],
  'BK1-136': [
    {
      trigger: 'activated',
      quick: true,
      cost: { pay: '1' },
      effect: { do: 'buff', who: { scope: 'self' }, stats: { power: 1 } },
      text: '(Quick) 1: This character gets +1/+0 until end of turn.',
    },
  ],
  'BK1-139': [
    {
      trigger: 'activated',
      quick: true,
      cost: { pay: '2' },
      target: { where: 'thisArea' },
      effect: { do: 'buff', who: { scope: 'target' }, stats: { power: -4 } },
      text: '(Quick) 2: Target character in this area gets -4/+0 until end of turn.',
    },
  ],
  'BK1-140': [
    {
      trigger: 'activated',
      quick: true,
      cost: { pay: '2' },
      target: { where: 'thisArea', maxLevel: 2 },
      effect: { do: 'destroy', who: { scope: 'target' } },
      text: '(Quick) 2: Destroy a level 2 or lower character in this area.',
    },
  ],

  'BK1-110': [
    {
      trigger: 'open',
      gate: true,
      // "A character attacked this area this turn" — a battle was declared
      // over it (§11 ①), whoever won.
      condition: { when: 'battleDeclaredThisArea' },
      target: { where: 'thisArea' },
      effect: { do: 'lock', who: { scope: 'target' } },
      text: 'This card can only be opened if a character attacked this area this turn. Lock target character in this area.',
    },
  ],
  'BK1-114': [
    {
      trigger: 'open',
      // "If this area is not occupied" gates the effect rather than the open:
      // the printed line is "when this card is opened, if …", not "can only
      // be opened if", so it may be opened into an occupied area and do
      // nothing. Compare BK1-110 and BK1-120, which say the other thing.
      condition: { when: 'areaUnoccupied' },
      effect: { do: 'lock', who: { scope: 'any', side: 'any', where: 'thisArea' } },
      text: 'When this card is opened, if this area is not occupied, lock all characters here.',
    },
  ],
  'BK1-128': [
    {
      trigger: 'activated',
      cost: { pay: '1', oncePerTurn: true },
      // A Set Card, not a character — the two populations never mix.
      target: { where: 'thisArea', faceDown: true },
      effect: { do: 'destroy', who: { scope: 'target' } },
      text: '1: Destroy a set card here. This can only be activated once each turn.',
    },
  ],
  'BK1-129': [
    {
      trigger: 'open',
      // "All of your characters in play that are level 1 or less" — the whole
      // board, and his own side only. He is Level 4, so he never hits himself.
      effect: {
        do: 'destroy',
        who: { scope: 'others', side: 'yours', where: 'anywhere', maxLevel: 1 },
      },
      text: 'When this card is opened, eliminate all of your characters in play that are level 1 or less.',
    },
    {
      trigger: 'activated',
      cost: { pay: '1', oncePerTurn: true },
      effect: { do: 'unlock', who: { scope: 'self' } },
      text: '1: Unlock this character, can only be activated once each turn.',
    },
  ],
  'BK1-130': [
    {
      trigger: 'open',
      // "All set cards", everywhere and both sides — the widest reading the
      // printed line allows, and it names no narrowing.
      effect: {
        do: 'destroy',
        who: { scope: 'others', side: 'any', where: 'anywhere', faceDown: true },
      },
      text: 'When this card is opened, destroy all set cards.',
    },
  ],
  'BK1-134': [
    {
      trigger: 'always',
      condition: { when: 'enemyLevelHere', level: 4 },
      effect: { do: 'buff', who: { scope: 'self' }, stats: { power: 1, hp: 1 } },
      text: 'While an enemy character, level 4 or higher, is in this area, this card gets +1/+1',
    },
  ],
  'BK1-144': [
    {
      trigger: 'open',
      // Its own card is face up by the time this resolves, so `others` is not
      // needed to keep it out — but a Set Card is the other population and it
      // is not one any more, so it is excluded either way.
      effect: {
        do: 'returnToHand',
        who: { scope: 'others', side: 'yours', where: 'anywhere', faceDown: true },
      },
      text: 'When this card is opened return all set cards you control to your hand.',
    },
  ],
  'BK1-146': [
    {
      trigger: 'open',
      target: { where: 'thisArea', faceDown: true },
      effect: { do: 'destroy', who: { scope: 'target' } },
      text: 'When this card is opened, destroy a set card in this area',
    },
  ],
  'BK1-149': [
    {
      trigger: 'open',
      target: { where: 'thisArea' },
      // Barred from the fight on either side, not merely from attacking.
      effect: { do: 'cannotBattle', who: { scope: 'target' } },
      text: 'Until end of turn, target character in this area cannot participate in battle.',
    },
  ],
  'BK1-153': [
    {
      trigger: 'open',
      // "Target open card" is the default population: a card standing face up.
      target: { where: 'thisArea' },
      effect: { do: 'destroy', who: { scope: 'target' } },
      text: 'When this card is opened, destroy target open card in this area',
    },
  ],

  'BK1-111': [
    {
      trigger: 'open',
      target: { side: 'yours', where: 'thisArea' },
      area: 'youOccupyOther',
      effect: { do: 'moveTo', who: { scope: 'target' }, where: 'chosenArea' },
      text: 'When this card is opened, move one of your character from this area to any other area you occupy.',
    },
  ],
  'BK1-112': [
    {
      trigger: 'activated',
      quick: true,
      cost: { pay: 'B' },
      // By printed name, so either Forest Guardian will do. Set and opened at
      // once, paying nothing further and outside the City Level gate.
      effect: {
        do: 'search',
        player: 'you',
        count: 1,
        named: 'Forest Guardian',
        to: 'setOpen',
      },
      text: '(Quick) B: Search your deck for a Forest Guardian card, set it in this area, and then open it. Shuffle your deck.',
    },
  ],

  'BK1-145': [
    {
      trigger: 'always',
      effect: {
        do: 'buff',
        who: { scope: 'any', side: 'any', where: 'thisArea' },
        stats: { power: 1 },
      },
      text: 'All characters in this area gain +1/+0.',
    },
    {
      trigger: 'always',
      // Read off the board when the city changes hands, like BK1-093 — but
      // this one stands in the city rather than among the attackers, and
      // pays whoever takes it.
      effect: { do: 'captureDraw', count: 3 },
      text: 'If a player captures this area they draw 3 cards instead of 2.',
    },
  ],
  'BK1-152': [
    {
      trigger: 'open',
      // "In play" — both sides, every area. The draw counts what this took,
      // so it rides on the destroy rather than following it.
      effect: {
        do: 'destroy',
        who: { scope: 'others', side: 'any', where: 'anywhere', effectCards: 'eternal' },
        drawPerDestroyed: true,
      },
      text: 'When this card is opened, destroy all eternal effect cards in play, then draw that many cards',
    },
  ],

  'BK1-141': [
    {
      trigger: 'open',
      // "You may look at" — she reads them, nobody else does. She is face up
      // by the time this resolves, so `others` keeps her out of her own peek.
      effect: {
        do: 'reveal',
        who: { scope: 'others', side: 'any', where: 'thisArea', faceDown: true },
        to: 'you',
      },
      text: 'When this card Is opened, you may look at all set cards in this area.',
    },
  ],
  'BK1-142': [
    {
      trigger: 'open',
      // "Reveal" — shown to both players, everywhere, and then the Effect
      // cards among them are destroyed. One printed line, so one ability.
      effect: {
        do: 'reveal',
        who: { scope: 'others', side: 'theirs', where: 'anywhere', faceDown: true },
        to: 'both',
      },
      then: [
        {
          do: 'destroy',
          who: {
            scope: 'others',
            side: 'theirs',
            where: 'anywhere',
            faceDown: true,
            effectCards: 'any',
          },
        },
      ],
      text: 'When this card is opened, reveal all enemy set cards in all areas and destroy all effect cards among them.',
    },
  ],

  'BK1-107': [
    {
      trigger: 'open',
      gate: true,
      condition: { when: 'enemyArrivedThisArea' },
      // "That card" is the one that moved in, so the player is asked to point
      // at it: the engine records that an arrival happened, not which card it
      // was, and an enemy that arrived is a legal choice either way.
      target: { side: 'theirs', where: 'thisArea' },
      effect: { do: 'lock', who: { scope: 'target' }, skipRefresh: 1 },
      text: 'This card can only be opened when an enemy character moved to this area this turn. That card does not unlock during the next refresh phase when it would unlock.',
    },
  ],
  'BK1-108': [
    {
      trigger: 'open',
      // From an adjacent area to this one: Distance 1 reaches both, and the
      // move is a no-op for anybody already standing here.
      target: { side: 'theirs', maxDistance: 1 },
      effect: { do: 'moveTo', who: { scope: 'target' }, where: 'sourceArea' },
      then: [
        { do: 'unlock', who: { scope: 'target' } },
        { do: 'draw', player: 'you', count: 1 },
      ],
      text: 'When this card is opened, move an enemy character from an adjacent area to this area, unlock that character. Draw 1 card.',
    },
  ],
  'BK1-143': [
    {
      trigger: 'open',
      gate: true,
      condition: { when: 'openedCharacterHere' },
      // "All your characters" — from anywhere on the board to this area.
      effect: {
        do: 'moveTo',
        who: { scope: 'any', side: 'yours', where: 'anywhere' },
        where: 'sourceArea',
      },
      text: 'You can only open this card if you opened a character in this area this turn. Move all your characters to this area.',
    },
  ],
  'BK1-148': [
    {
      trigger: 'open',
      // "Reduced to 0" is a shield nothing can exceed, written onto everybody
      // standing here for the turn and swept with the boosts (§10 ⑤). Both
      // sides: the printed line says "all damage in this area".
      effect: {
        do: 'reduceDamage',
        who: { scope: 'any', side: 'any', where: 'thisArea' },
        amount: 99,
      },
      text: 'When this card is opened, until end of turn, all damage dealt in this area is reduced to 0.',
    },
  ],

  'BK1-113': [
    {
      trigger: 'open',
      effect: { do: 'draw', player: 'you', count: 2 },
      text: 'When this card is opened, draw 2 cards.',
    },
    {
      // Fires for whoever turns up — opened here or moved here — and asks
      // them for two cards or the character. Both ways in are §13's arrival.
      trigger: 'arrival',
      condition: { when: 'targetDoesNotOccupyThisArea' },
      effect: { do: 'destroyOrDiscard', who: { scope: 'target' }, discard: 2 },
      text: 'Any player who opens a character here or moves a character here while they do not occupy this area, must discard 2 cards or destroy that character.',
    },
  ],
  'BK1-115': [
    {
      trigger: 'turnEnd',
      // "You may" — declinable, and it looks in the Trash as well as the
      // deck (§14 makes the Trash public, so nothing leaks by offering it).
      effect: {
        do: 'may',
        effects: [
          {
            do: 'search',
            player: 'you',
            count: 1,
            named: 'Insect Elf',
            includeTrash: true,
            to: 'setOpen',
          },
        ],
      },
      text: 'At the end of your turn, you may search your deck or your graveyard for an "Insect Elf" card, set it in this area, then open it. Shuffle your deck.',
    },
  ],
  'BK1-116': [
    {
      trigger: 'open',
      effect: { do: 'draw', player: 'you', count: 2 },
      text: 'When this card is opened, draw 2 cards.',
    },
    {
      trigger: 'always',
      // Read off the board by `rules.ts:openLevelFor` when a card is opened.
      // City Level itself is untouched — §5 defines it as the face-up count.
      effect: { do: 'openLevel', player: 'occupier', shift: -1 },
      text: 'The player who occupies this area can only open cards as if the level were 1 lower.',
    },
  ],

  'BK1-150': [
    {
      trigger: 'open',
      target: { side: 'yours', where: 'thisArea' },
      // One printed line: destroy, then dig for a replacement, which joins
      // the fight if the one it replaced was in it (§11 ③).
      effect: { do: 'destroy', who: { scope: 'target' } },
      then: [{ do: 'revealUntilCharacter', to: 'setOpen', joinsBattle: true }],
      text: 'When this card is opened, destroy target character you control in this area. Then reveal cards from the top of your library until you reveal a character card, set that card in this area, and then open it. If the destroyed character was in battle, the newly opened card joins the battle.',
    },
  ],

  'BK1-131': [
    {
      trigger: 'activated',
      cost: { pay: '3' },
      // "There must be another character to move for this to be used" — the
      // companion is a required target, so with nobody else standing here
      // `canActivate` finds no legal one and the ability is never offered.
      // Either side's, as printed.
      target: { where: 'thisArea', excludeSelf: true },
      area: 'withinTwo',
      effect: {
        do: 'moveTo',
        who: { scope: 'target' },
        where: 'chosenArea',
        withSource: true,
      },
      text: '3: Move this and another character from this area to another area within distance 2.',
    },
  ],

  'BK1-011': [
    {
      trigger: 'activated',
      quick: true,
      cost: { pay: '1', oncePerTurn: true },
      effect: { do: 'buff', who: { scope: 'self' }, stats: { power: 1, hp: 1 } },
      text: '(Quick) 1: This character gets +1/+1 until end of turn. Use only once per turn.',
    },
  ],
  'BK1-015': [
    {
      trigger: 'activated',
      quick: true,
      cost: { pay: 'W' },
      target: { where: 'thisArea' },
      effect: { do: 'damage', who: { scope: 'target' }, amount: 1 },
      text: '(Quick) W: This character deals 1 damage to a target character in this area.',
    },
  ],
  'BK1-019': [
    {
      trigger: 'activated',
      quick: true,
      cost: { pay: 'W', oncePerTurn: true },
      effect: { do: 'buff', who: { scope: 'self' }, stats: { power: 2, hp: -1 } },
      text: '(Quick) W: This character gains +2/-1 until end of turn. Do this only once per turn.',
    },
  ],
  'BK1-021': [
    {
      trigger: 'activated',
      cost: { lockSelf: true },
      // "You may look at" — he reads them, nobody else does.
      effect: {
        do: 'reveal',
        who: { scope: 'others', side: 'any', where: 'thisArea', faceDown: true },
        to: 'you',
      },
      text: 'Tap: You may look at all set cards in this area.',
    },
  ],
  'BK1-160': [
    {
      trigger: 'open',
      // "To this area", from anywhere — the card names no Distance.
      target: { side: 'yours', where: 'anywhere' },
      effect: { do: 'moveTo', who: { scope: 'target' }, where: 'sourceArea' },
      text: 'When this card is opened, move a target character you control to this area.',
    },
  ],
  'BK1-033': [
    {
      trigger: 'open',
      // "If the area level is 2 or less" — City Level, §5. A gate on the
      // effect rather than the open: "when this card is opened, if …".
      condition: { when: 'cityLevelAtMost', level: 2 },
      target: { side: 'yours', where: 'thisArea' },
      effect: { do: 'returnToHand', who: { scope: 'target' } },
      text: 'When this card is opened, if the area level is 2 or less, return 1 character you control in this area to your hand.',
    },
  ],
  'BK1-035': [
    {
      trigger: 'open',
      gate: true,
      condition: { when: 'openedCharacterHere' },
      // "All characters in this area" — both sides, as printed. They are
      // unlocked and then barred from the fight for the rest of the turn.
      effect: { do: 'unlock', who: { scope: 'any', side: 'any', where: 'thisArea' } },
      then: [{ do: 'cannotBattle', who: { scope: 'any', side: 'any', where: 'thisArea' } }],
      text: 'When this card is opened, if you opened a character in this area this turn, unlock all characters in this area. Characters unlocked this way cannot participate in battle the rest of the turn.',
    },
  ],
  'BK1-037': [
    {
      trigger: 'open',
      gate: true,
      condition: { when: 'youCapturedThisArea' },
      effect: { do: 'unlock', who: { scope: 'any', side: 'yours', where: 'thisArea' } },
      then: [
        {
          do: 'buff',
          who: { scope: 'any', side: 'yours', where: 'thisArea' },
          stats: { move: 2 },
        },
        { do: 'cannotBattle', who: { scope: 'any', side: 'yours', where: 'thisArea' } },
      ],
      text: 'When this card is opened, if you captured this area this turn, unlock all characters you control in this area. They receive +2 Movement until end of turn. They cannot participate in battle this turn.',
    },
  ],
  'BK1-038': [
    {
      trigger: 'open',
      // Your own Hawks, everywhere on the board.
      effect: {
        do: 'unlock',
        who: { scope: 'any', side: 'yours', where: 'anywhere', subtype: 'hawk' },
      },
      then: [
        {
          do: 'buff',
          who: { scope: 'any', side: 'yours', where: 'anywhere', subtype: 'hawk' },
          stats: { power: 1, hp: 1 },
        },
      ],
      text: 'Unlock all "Hawk" characters. They all gain +1/+1 until end of turn.',
    },
  ],
  'BK1-154': [
    {
      trigger: 'open',
      // "Characters that are not in this area" — both sides, everywhere else.
      // 99 is a shield nothing can exceed, so damage lands as nothing.
      effect: {
        do: 'reduceDamage',
        who: { scope: 'any', side: 'any', where: 'elsewhere' },
        amount: 99,
      },
      text: 'Until end of turn, characters that are not in this area have their damage taken reduced to 0.',
    },
  ],

  'BK1-028': [
    {
      trigger: 'open',
      gate: true,
      // Two printed conditions, and `Condition` holds one — the City Level
      // ceiling is the one that can shut before anything is paid, so it
      // gates; the arrival is checked by the target having somebody to point
      // at. RULES: "area level" read as City Level (§5).
      condition: { when: 'cityLevelAtMost', level: 1 },
      target: { side: 'yours', where: 'thisArea' },
      effect: { do: 'unlock', who: { scope: 'target' } },
      then: [{ do: 'draw', player: 'you', count: 1 }],
      text: 'This card can only be opened if the area level is 1 or less, and if a character you control moved to this area this turn. Unlock 1 character you control here, then draw 1 card.',
    },
  ],
  'BK1-036': [
    {
      trigger: 'open',
      gate: true,
      condition: { when: 'allyArrivedThisArea' },
      // "A character that moved to this area this turn" — the engine records
      // that an arrival happened rather than which card it was, so the
      // player points at one of their own standing here.
      target: { side: 'yours', where: 'thisArea' },
      effect: { do: 'unlock', who: { scope: 'target' } },
      then: [{ do: 'draw', player: 'you', count: 2 }],
      text: 'When this card is opened, unlock a character that moved to this area this turn. Then draw 2 cards.',
    },
  ],

  'BK1-023': [
    {
      trigger: 'open',
      // "If you captured this area this turn" gates the effect, not the open:
      // the printed line is "when this card is opened, if …".
      condition: { when: 'youCapturedThisArea' },
      // Look at five, take two. The look is what `topOfDeck` bounds — and it
      // is what `view.ts` reveals, so the rest of the deck stays secret. No
      // shuffle follows, because looking at the top is not a search (§13).
      effect: {
        do: 'search',
        player: 'you',
        count: 2,
        named: null,
        topOfDeck: 5,
        to: 'hand',
      },
      text: 'When this card is opened, if you captured this area this turn, look at the top 5 cards of your library, select 2 to put into your hand.',
    },
  ],

  'BK1-159': [
    {
      trigger: 'open',
      // "Do not shuffle" is printed, and is also what the engine does anyway:
      // looking at the top is not a search, so §13's shuffle never applies.
      effect: { do: 'reorderTop', count: 4 },
      text: 'When this card is opened, look at the top 4 cards of your deck and put them back in any order. Do not shuffle.',
    },
  ],

  'BK1-155': [
    {
      trigger: 'open',
      gate: true,
      // "If you occupy no areas and your opponent occupies at least 2" — a
      // gate, so a player who is not losing is never offered it (§13).
      condition: { when: 'losingBadly', enemyAtLeast: 2 },
      // Look at seven and set them all, each wherever the player says. Not a
      // search, so nothing is shuffled afterwards.
      effect: {
        do: 'search',
        player: 'you',
        count: 7,
        named: null,
        topOfDeck: 7,
        to: 'setAnywhere',
      },
      text: 'This card can only be opened if you occupy no areas and your opponent occupies at least 2 areas. Look at the top 7 cards of your deck and set them anywhere.',
    },
  ],

  'BK1-030': [
    {
      trigger: 'open',
      // "1 set white character card you have in this area" — face down, your
      // own, white, and a character. Free and outside the City Level gate.
      target: { side: 'yours', where: 'thisArea', faceDown: true, colour: 'white' },
      effect: { do: 'openSetCard', who: { scope: 'target' } },
      text: 'When this card Is opened, open 1 set white character card you have in this area.',
    },
  ],
  'BK1-031': [
    {
      trigger: 'open',
      // Either side's Set Card: the printed line names neither.
      target: { where: 'thisArea', faceDown: true },
      effect: { do: 'seal', who: { scope: 'target' } },
      text: 'When this card is opened, target 1 set card in this area, it cannot be opened this turn.',
    },
  ],
  'BK1-034': [
    {
      trigger: 'open',
      condition: { when: 'youOccupyThisArea' },
      // "Target attacking character" — committed, and on the attacking side.
      // With no battle on there is nobody to point at and it does nothing.
      target: { attacking: true },
      effect: { do: 'damage', who: { scope: 'target' }, amount: 3 },
      text: 'When this card is opened, if you occupy this area, deal 3 damage to target attacking character.',
    },
  ],

  'BK1-029': [
    {
      trigger: 'open',
      target: { side: 'yours', where: 'thisArea' },
      // One printed line, two grants: the flat boost, and a further +1/+1
      // that only counts while it is defending (§11).
      effect: { do: 'buff', who: { scope: 'target' }, stats: { power: 1, hp: 2 } },
      then: [{ do: 'defenderBonus', who: { scope: 'target' }, stats: { power: 1, hp: 1 } }],
      text: 'When this card is opened, target a character you control in this area, it gains +1/+2 until end of turn. While defending it gains an additional +1/+1.',
    },
  ],

  'BK1-147': [
    {
      trigger: 'open',
      gate: true,
      // §11 ① — a battle was declared here by the other player, so its
      // controller is the one who defended.
      condition: { when: 'defendedThisArea' },
      // "Any number of characters": named one at a time and stoppable, since
      // one target per ability is all the wire carries. Either side's, as
      // printed, and from anywhere on the board.
      effect: {
        do: 'gatherHere',
        who: { scope: 'any', side: 'any', where: 'anywhere' },
        count: 5,
        unlock: true,
      },
      text: 'You can only open this card if you defended this area this turn. Target any number of characters and move them to this area and unlock them.',
    },
  ],

  'BK1-158': [
    {
      trigger: 'open',
      effect: { do: 'draw', player: 'you', count: 2 },
      text: 'When this card is opened, draw 2 cards.',
    },
    {
      trigger: 'enemyCapture',
      // Into the area they just took, not into this card's own — the trigger
      // hands the captured city over as the chosen area.
      effect: { do: 'setTopOfDeck', where: 'chosenArea' },
      text: 'Whenever your opponent captures an area, set the top card of your library in that area.',
    },
  ],

  'BK1-027': [
    {
      trigger: 'open',
      // "A level 1 or lower character in this area" — either side's, as
      // printed; it is normally pointed at an enemy about to swing.
      target: { where: 'thisArea', maxLevel: 1 },
      effect: { do: 'reflectDamage', who: { scope: 'target' } },
      text: 'Target a level 1 or lower character in this area. Until end of turn any damage dealt by that character to any of your characters in this area is instead dealt to itself.',
    },
  ],

  'BK1-157': [
    {
      trigger: 'open',
      // "An enemy character" — anywhere on the board, since the pin is about
      // where *this* card stands rather than where the target does.
      target: { side: 'theirs', where: 'anywhere' },
      // Written onto this card, because the two clauses below are continuous
      // and have to keep answering for a choice made once (§13).
      effect: { do: 'mark' },
      text: 'When this card is opened, target an enemy character.',
    },
    {
      trigger: 'always',
      effect: { do: 'markedCannotAttackHere' },
      text: 'That character cannot attack this area.',
    },
    {
      trigger: 'always',
      effect: { do: 'markedDiesIfItLeaves' },
      text: 'If that character is in this area, destroy it if it were to move to another area.',
    },
  ],

  'BK1-022': [
    {
      trigger: 'open',
      // "To yourself" — the city stays face down for everybody, including
      // its opponent, so City Level is untouched (§5).
      effect: { do: 'seeCapital' },
      text: 'When this card is opened, you reveal the capital to yourself.',
    },
  ],

  'BK1-151': [
    {
      trigger: 'open',
      // "All abilities of normal effects within 1 distance" — both sides'
      // (the line names neither), face-up Normal Effect cards standing in
      // this area or the ones beside it (§15). Its own card is a Normal
      // Effect too, and is excluded in the reducer: silencing itself would
      // undo the silencing.
      effect: {
        do: 'negate',
        who: { scope: 'others', side: 'any', maxDistance: 1, effectCards: 'normal' },
      },
      text: 'When this card is opened negate all abilities of normal effects with 1 distance until end of turn.',
    },
  ],

  'BK1-156': [
    {
      trigger: 'always',
      condition: { when: 'enemyOccupiesThisArea' },
      effect: {
        do: 'buff',
        who: { scope: 'any', side: 'theirs', where: 'thisArea' },
        stats: { power: -2 },
      },
      text: 'While an enemy occupies the city in this area, all enemy character in this area get -2/-0',
    },
  ],
};

export const abilitiesFor = (cardId: string): readonly Ability[] => ABILITIES[cardId] ?? [];

/** Every card this registry gives behaviour to. For coverage reporting. */
export const cardsWithAbilities = (): readonly string[] => Object.keys(ABILITIES);

/* ------------------------------------------------------------- selection */

/** Does this card fall inside the selector, seen from `source`? */
/** What a selector needs to know about a card, looked up by the caller. */
export interface CardFacts {
  readonly subtypes: readonly string[];
  readonly level: number | null;
  readonly colour: CardColor;
}

export function selects(
  selector: Selector,
  source: CardInstance,
  card: CardInstance,
  factsOf: (card: CardInstance) => CardFacts,
  chosen?: CardInstanceId | undefined,
): boolean {
  const scope = selector.scope ?? 'self';
  // A chosen target is the whole selection: the player already narrowed it.
  if (scope === 'target') return chosen !== undefined && card.instanceId === chosen;
  if (scope === 'self') return card.instanceId === source.instanceId;
  if (scope === 'others' && card.instanceId === source.instanceId) return false;

  // Two populations, never both at once: cards lying face down, or characters
  // standing face up. Checked after the scope cases, which have already named
  // one card and do not need narrowing.
  if ((selector.faceDown ?? false) === card.faceUp) return false;

  const side = selector.side ?? 'yours';
  if (side === 'yours' && card.controller !== source.controller) return false;
  if (side === 'theirs' && card.controller === source.controller) return false;

  if (selector.maxDistance !== undefined) {
    // Distance widens "this area" outwards; §15 counts from the source.
    if (source.cityIndex === undefined || card.cityIndex === undefined) return false;
    if (Math.abs(source.cityIndex - card.cityIndex) > selector.maxDistance) return false;
  } else {
    const where = selector.where ?? 'thisArea';
    if (where === 'thisArea' && card.cityIndex !== source.cityIndex) return false;
    // "Not in this area" — everywhere the source is not standing.
    if (where === 'elsewhere' && card.cityIndex === source.cityIndex) return false;
  }
  const facts = factsOf(card);
  if (selector.subtype !== undefined && !facts.subtypes.includes(selector.subtype)) return false;
  if (selector.colour !== undefined && facts.colour !== selector.colour) return false;
  if (
    selector.maxLevel !== undefined &&
    (facts.level === null || facts.level > selector.maxLevel)
  ) {
    return false;
  }
  return true;
}

/** The player an effect's `you`/`opponent` refers to. */
export const targetPlayer = (
  state: Pick<GameState, 'seats' | 'cities'>,
  controller: PlayerId,
  which: EffectPlayer,
  source?: Pick<CardInstance, 'cityIndex'>,
): PlayerId | null => {
  if (which === 'you') return controller;
  // "That player", meaning whoever holds the area the card sits in — which
  // may be either side, or nobody at all (BK1-104).
  if (which === 'occupier') {
    if (!source || source.cityIndex === undefined) return null;
    return state.cities[source.cityIndex]?.occupiedBy ?? null;
  }
  return state.seats.find((seat) => seat !== controller) ?? null;
};
