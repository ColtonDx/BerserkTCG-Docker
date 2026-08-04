import type { Ability } from './abilities.js';
import type { CardDefId } from './ids.js';

/**
 * Card *definitions* — the printed card, shared by every copy in every match.
 * Definitions are immutable data loaded at startup; per-match mutable state
 * lives on `CardInstance` in `types.ts`.
 *
 * Modelled on Rules.md §3 (card types), §4 (card data) and §7 (costs).
 */

/** Rules.md §3 "Card colors". Every character and effect card is one of four. */
export type CardColor = 'white' | 'green' | 'black' | 'red';

export const CARD_COLORS: readonly CardColor[] = ['white', 'green', 'black', 'red'];

/** Rules.md §3. Cities are not cards in a player's deck; see `City` in types.ts. */
export type CardKind = 'character' | 'effect';

/** Rules.md §3 "Effect cards". Normal resolves once; Eternal stays on the field. */
export type EffectDuration = 'normal' | 'eternal';

/** Rules.md §4 "Rarity marks". */
export type Rarity = 'common' | 'uncommon' | 'rare';

/**
 * One cost icon. A coloured icon is paid with a card of that colour; the multi
 * icon (`'any'`) is paid with `count` cards of any colour. Rules.md §7.
 */
export interface CostIcon {
  readonly color: CardColor | 'any';
  readonly count: number;
}

export type Cost = readonly CostIcon[];

/** Rules.md §11 "Damage Exchange" — Power dealt, HP absorbed. */
export interface CharacterStats {
  /** How many cities it can travel in one move. Rules.md §10 ④. */
  readonly move: number;
  /** Attack priority — higher Range deals damage first. Rules.md §11 ④. */
  readonly range: number;
  readonly power: number;
  readonly hp: number;
}

export interface CardDefinition {
  readonly id: CardDefId;
  readonly name: string;
  readonly kind: CardKind;
  readonly color: CardColor;
  /**
   * Gated by City Level when opening. Rules.md §7. Null when the printed level
   * has not been captured yet — such a card cannot be opened, rather than
   * being treated as free.
   */
  readonly level: number | null;
  /** Null when the printed cost has not been captured. See Docs/CardData.md. */
  readonly cost: Cost | null;
  /** Character stats. Required for `kind: 'character'`, absent otherwise. */
  readonly stats?: CharacterStats;
  /** Effect duration. Required for `kind: 'effect'`, absent otherwise. */
  readonly duration?: EffectDuration;
  /**
   * Card subtypes, e.g. `['mercenary']`. Mercenary matters for deckbuilding:
   * it is exempt from the 3-copy cap and has a 10-card minimum. Rules.md §2.
   */
  readonly subtypes?: readonly string[];
  /** Only one card of this name may be on the field at a time. Rules.md §8. */
  readonly unique?: boolean;
  /** Usable at any time and can interrupt. Rules.md §13 "Quick". */
  readonly quick?: boolean;
  /** Rules text as printed, for display only — never parsed for behaviour. */
  readonly text?: string;
  /**
   * What the card does, as data. Kept here rather than parsed out of `text`,
   * so the engine stays data-driven and a card with no entry does nothing at
   * all rather than something approximate. See `abilities.ts`.
   */
  readonly abilities?: readonly Ability[];
  readonly rarity?: Rarity;
  /** Printed card number, e.g. `BK1-001`. */
  readonly cardNo?: string;
  readonly set?: string;
  /** Relative path under the web client's card art directory. */
  readonly art?: string;
}

export const MERCENARY_SUBTYPE = 'mercenary';

/**
 * Whether a card carries the Mercenaries *faction* on its type line. This is
 * NOT the deckbuilding rule — that turns on the card being named "Mercenary".
 * See `deck.ts`.
 */
export const hasMercenaryFaction = (def: CardDefinition): boolean =>
  def.subtypes?.includes(MERCENARY_SUBTYPE) ?? false;

/** Total number of cards a cost requires from hand. Rules.md §7. */
export const costTotal = (cost: Cost): number =>
  cost.reduce((total, icon) => total + icon.count, 0);

const COST_LETTERS: Readonly<Record<string, CardColor>> = {
  R: 'red',
  B: 'black',
  W: 'white',
  G: 'green',
};

/**
 * Parses the cost notation used in the card database (DesignNotes 8):
 * letters for colours and a leading number for generic cost.
 *
 *   `BB`   -> two black
 *   `1B`   -> one generic, one black
 *   `RGB`  -> one red, one green, one black
 *   ``/`0` -> free
 *
 * Any card can pay a generic cost; a coloured cost needs a card of that colour.
 */
export function parseCost(notation: string): Cost {
  const trimmed = notation.trim().toUpperCase();
  if (trimmed === '' || trimmed === '0') return [];

  const counts = new Map<CardColor | 'any', number>();

  for (const token of trimmed.matchAll(/(\d+)|([RBWG])/g)) {
    const [, generic, letter] = token;
    if (generic !== undefined) {
      counts.set('any', (counts.get('any') ?? 0) + Number(generic));
    } else if (letter !== undefined) {
      const color = COST_LETTERS[letter] as CardColor;
      counts.set(color, (counts.get(color) ?? 0) + 1);
    }
  }

  const consumed = trimmed.replace(/\d+|[RBWG]/g, '');
  if (consumed !== '') throw new Error(`Invalid cost notation: ${notation}`);

  // Generic first, matching how costs are printed.
  const cost: CostIcon[] = [];
  const generic = counts.get('any');
  if (generic) cost.push({ color: 'any', count: generic });
  for (const color of CARD_COLORS) {
    const count = counts.get(color);
    if (count) cost.push({ color, count });
  }
  return cost;
}

/** Renders a cost back to the database notation. Inverse of `parseCost`. */
export function formatCost(cost: Cost): string {
  const generic = cost.find((icon) => icon.color === 'any')?.count ?? 0;
  const letters = CARD_COLORS.flatMap((color) => {
    const count = cost.find((icon) => icon.color === color)?.count ?? 0;
    const letter = Object.entries(COST_LETTERS).find(([, c]) => c === color)?.[0] ?? '';
    return Array.from({ length: count }, () => letter);
  }).join('');
  return `${generic > 0 ? generic : ''}${letters}` || '0';
}

/** Lookup for every known card definition. */
export class CardRegistry {
  private readonly byId = new Map<CardDefId, CardDefinition>();

  constructor(definitions: readonly CardDefinition[] = []) {
    for (const def of definitions) this.add(def);
  }

  add(def: CardDefinition): void {
    if (this.byId.has(def.id)) throw new Error(`Duplicate card definition: ${def.id}`);
    if (def.kind === 'character' && !def.stats) {
      throw new Error(`Character card ${def.id} is missing stats`);
    }
    if (def.kind === 'effect' && !def.duration) {
      throw new Error(`Effect card ${def.id} is missing a duration`);
    }
    this.byId.set(def.id, def);
  }

  /** Throws on unknown ids — a missing definition is an engine bug, not a rules violation. */
  get(id: CardDefId): CardDefinition {
    const def = this.byId.get(id);
    if (!def) throw new Error(`Unknown card definition: ${id}`);
    return def;
  }

  has(id: CardDefId): boolean {
    return this.byId.has(id);
  }

  all(): CardDefinition[] {
    return [...this.byId.values()];
  }

  get size(): number {
    return this.byId.size;
  }
}
