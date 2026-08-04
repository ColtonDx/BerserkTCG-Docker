import type { CardInstance, GameState } from './types.js';
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

/** What the ability does when it applies. */
export type Effect =
  /**
   * Change numbers. Under an `always` trigger this is continuous and read
   * off the board; under any other trigger it lasts to the end of the turn
   * and is written onto the card.
   */
  | { readonly do: 'buff'; readonly who: Selector; readonly stats: StatLine }
  | { readonly do: 'draw'; readonly player: 'you' | 'opponent'; readonly count: number }
  | { readonly do: 'discard'; readonly player: 'you' | 'opponent'; readonly count: number }
  | { readonly do: 'unlock'; readonly who: Selector }
  | { readonly do: 'returnToHand'; readonly who: Selector }
  /** Rules.md §11 — may not lead or join an attack. */
  | { readonly do: 'cannotAttack'; readonly who: Selector };

/**
 * When an ability does its work.
 *
 * `always` is Rules.md §13's cost-free continuous ability: it is not an event
 * at all, it is read off the board wherever the numbers are needed. The rest
 * fire once and write their result onto the game state.
 */
export type Trigger = 'always' | 'open' | 'attack' | 'turnStart' | 'turnEnd';

export interface Ability {
  readonly trigger: Trigger;
  readonly effect: Effect;
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

export const BOOST_COUNTERS: readonly string[] = [BOOST_POWER, BOOST_HP, BOOST_MOVE];

const COUNTER_FOR: Readonly<Record<keyof StatLine, string>> = {
  power: BOOST_POWER,
  hp: BOOST_HP,
  move: BOOST_MOVE,
};

export const counterFor = (stat: keyof StatLine): string => COUNTER_FOR[stat];

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
      text: 'When this card is opened, draw 1 card and your opponent discards 1 card.',
    },
    {
      trigger: 'open',
      effect: { do: 'discard', player: 'opponent', count: 1 },
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
  'BK1-040': [
    {
      trigger: 'open',
      target: { where: 'thisArea' },
      effect: { do: 'buff', who: { scope: 'target' }, stats: { power: 2, hp: 2 } },
      text: 'When this card is opened, target character in this area gains +2/+2 until end of turn.',
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
export function selects(
  selector: Selector,
  source: CardInstance,
  card: CardInstance,
  subtypesOf: (card: CardInstance) => readonly string[],
  chosen?: CardInstanceId | undefined,
): boolean {
  const scope = selector.scope ?? 'self';
  // A chosen target is the whole selection: the player already narrowed it.
  if (scope === 'target') return chosen !== undefined && card.instanceId === chosen;
  if (scope === 'self') return card.instanceId === source.instanceId;
  if (scope === 'others' && card.instanceId === source.instanceId) return false;

  const side = selector.side ?? 'yours';
  if (side === 'yours' && card.controller !== source.controller) return false;
  if (side === 'theirs' && card.controller === source.controller) return false;

  if ((selector.where ?? 'thisArea') === 'thisArea' && card.cityIndex !== source.cityIndex) {
    return false;
  }
  if (selector.subtype !== undefined && !subtypesOf(card).includes(selector.subtype)) return false;
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
