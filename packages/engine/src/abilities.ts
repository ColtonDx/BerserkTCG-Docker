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

/** A change to a character's printed numbers. Absent fields are unchanged. */
export interface StatLine {
  readonly power?: number;
  readonly hp?: number;
  readonly move?: number;
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
  readonly where?: 'thisArea' | 'anywhere';
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
  /**
   * The ability also asks for an **area**, chosen after the character.
   *
   * `adjacent` is the only kind so far: "move it to an adjacent area"
   * (BK1-032), meaning a city next to the chosen character's own, which is
   * index ±1 along the row. It is a real choice anywhere but the two ends,
   * where only one neighbour exists and the engine takes it without asking.
   *
   * The choice travels in `OPEN_CARD.areas` / `USE_ABILITY.areas`, not in
   * `targets`: an area is not a card, and an ability may want either or both.
   */
  readonly area?: 'adjacent';
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
  | { readonly when: 'openedThisTurn' };

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
      readonly player: 'you' | 'opponent';
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
  | { readonly do: 'discard'; readonly player: 'you' | 'opponent'; readonly count: number }
  /**
   * Take a card out of your deck and shuffle. Rules.md §13.
   *
   * `named` is the printed restriction — "add 1 Serpico from your deck" — and
   * matches the card's printed *name*, so any printing of it will do. A search
   * that finds nothing simply finds nothing; it is not an error and does not
   * stop to ask.
   */
  | {
      readonly do: 'search';
      readonly player: 'you';
      readonly count: number;
      readonly named: string | null;
    }
  | { readonly do: 'unlock'; readonly who: Selector }
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
  | { readonly do: 'destroy'; readonly who: Selector }
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
   * - `adjacentArea` — "move it to an adjacent area" (BK1-032). Which one is
   *   the player's choice, and it is a real one at any city but the two ends
   *   of the row, so it is asked as a second target: `TargetSpec.area` marks
   *   the ability as wanting an area, and the destination rides in the
   *   action's `areas` alongside its chosen characters.
   */
  | {
      readonly do: 'moveTo';
      readonly who: Selector;
      readonly where: 'sourceArea' | 'adjacentArea';
    }
  /** Rules.md §11 — may not lead or join an attack. */
  | { readonly do: 'cannotAttack'; readonly who: Selector };

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

export const BOOST_COUNTERS: readonly string[] = [BOOST_POWER, BOOST_HP, BOOST_MOVE, SHIELD];

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
      target: { side: 'theirs', where: 'thisArea', maxLevel: 2, area: 'adjacent' },
      effect: { do: 'moveTo', who: { scope: 'target' }, where: 'adjacentArea' },
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

  if ((selector.where ?? 'thisArea') === 'thisArea' && card.cityIndex !== source.cityIndex) {
    return false;
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
  state: Pick<GameState, 'seats'>,
  controller: PlayerId,
  which: 'you' | 'opponent',
): PlayerId | null => {
  if (which === 'you') return controller;
  return state.seats.find((seat) => seat !== controller) ?? null;
};
