import { useEffect, useState } from 'react';

/**
 * Card names, by printed number.
 *
 * The board deals in ids — `BK1-011` — because that is what the server sends
 * and what joins a card to its art. Nobody plays a game about `BK1-011`, so
 * everything a player reads goes through here and comes out as *Guts*.
 *
 * Fetched once and shared: names are printed on cardboard and never change,
 * so a second match has nothing new to learn. Until it arrives, `nameOf`
 * hands back the id, which is worse than a name but better than nothing.
 */

const API = import.meta.env['VITE_SERVER_URL'] ?? '';

let names: ReadonlyMap<string, string> | null = null;
let inFlight: Promise<ReadonlyMap<string, string>> | null = null;

interface CatalogueRow {
  readonly id: string;
  readonly name: string | null;
  readonly cost: string | null;
  readonly color: string | null;
  readonly power: number | null;
  readonly hp: number | null;
  readonly range: number | null;
  readonly movement: number | null;
  readonly type: string | null;
  readonly duration: string | null;
  readonly effect: string | null;
  readonly subtypes: readonly string[];
  /** Whether the engine carries this card's behaviour yet. Rules.md §13. */
  readonly implemented?: boolean;
  readonly abilities?: readonly CardAbility[];
}

/**
 * One of a card's abilities, as the engine has it. Rules.md §13.
 *
 * Static card data, not game state: `legalActions` names an ability by its
 * index on the card (`abilityKey`), which is a number carrying no label and no
 * price. Without this the menu could offer "ability 0" and nothing more.
 */
export interface CardAbility {
  readonly key: string;
  readonly text: string;
  /** Used by choice and paid for — the only kind that can be offered. */
  readonly activated: boolean;
  readonly quick: boolean;
  /** Cards out of hand, in the DesignNotes 8 notation. Null if it costs none. */
  readonly cost: string | null;
  /** The printed "Tap:" — it locks its own card as a cost. Rules.md §6. */
  readonly lockSelf: boolean;
  readonly oncePerTurn: boolean;
  /**
   * Whether the effect asks to be pointed at somebody. A cost that locks an
   * ally also puts a name in the action, so the two cannot be told apart from
   * the action alone.
   */
  readonly targets: boolean;
}

const costs = new Map<string, string>();
const texts = new Map<string, string>();
const implemented = new Set<string>();
const abilities = new Map<string, readonly CardAbility[]>();
const subtypes = new Map<string, readonly string[]>();
const colours = new Map<string, string>();
const stats = new Map<string, { power: number; hp: number; range: number; move: number }>();
/** Cards that remain on the table once opened: characters and Eternals. */
const permanent = new Set<string>();

async function load(): Promise<ReadonlyMap<string, string>> {
  const response = await fetch(`${API}/api/catalogue`);
  if (!response.ok) throw new Error(`catalogue: ${response.status}`);
  const body = (await response.json()) as { cards: readonly CatalogueRow[] };
  const map = new Map<string, string>();
  for (const card of body.cards) {
    if (card.name) map.set(card.id, card.name);
    if (card.cost) costs.set(card.id, card.cost);
    if (card.effect) texts.set(card.id, card.effect);
    if (card.implemented) implemented.add(card.id);
    if (card.abilities && card.abilities.length > 0) abilities.set(card.id, card.abilities);
    if (card.subtypes.length > 0) subtypes.set(card.id, card.subtypes);
    if (card.color) colours.set(card.id, card.color);
    // Rules.md §3 — a Normal effect resolves and goes to the Trash; a
    // character or an Eternal stays where it was opened.
    if (card.type === 'character' || card.duration === 'eternal') permanent.add(card.id);
    if (card.power !== null && card.hp !== null && card.range !== null) {
      // Movement is the one that may be absent on a character the data is
      // still missing; zero is what an unstated Move behaves as anyway.
      stats.set(card.id, {
        power: card.power,
        hp: card.hp,
        range: card.range,
        move: card.movement ?? 0,
      });
    }
  }
  names = map;
  return map;
}

/**
 * The card's printed rules text, if it has been transcribed.
 *
 * Null covers both "this card has no ability" and "nobody has typed it in
 * yet"; the inspector says nothing either way rather than claiming the card
 * is blank. Docs/CardData.md tracks what is still outstanding.
 */
export function textOf(defId: string): string | null {
  return texts.get(defId) ?? null;
}

/**
 * This card's abilities as the engine has them, in printed order.
 *
 * Empty for a card whose behaviour is not built, which is why the menu offers
 * nothing on one — an ability that does not exist in `abilities.ts` is not an
 * ability the engine would accept.
 */
export function abilitiesOf(defId: string): readonly CardAbility[] {
  return abilities.get(defId) ?? [];
}

/** One ability of a card, by the key the wire names it with. */
export function abilityOf(defId: string, key: string): CardAbility | null {
  return abilitiesOf(defId).find((ability) => ability.key === key) ?? null;
}

/** Does the engine actually do what this card says? Rules.md §13. */
export function implementedIn(defId: string): boolean {
  return implemented.has(defId);
}

/** The printed type line's subtypes, e.g. `Hawk · Leader`. */
export function subtypesOf(defId: string): readonly string[] {
  return subtypes.get(defId) ?? [];
}

/** The card's printed name, or its id while the catalogue is still loading. */
export function nameOf(defId: string): string {
  return names?.get(defId) ?? defId;
}

/** The card's printed cost in the notation from DesignNotes 8, e.g. `1W`. */
export function costOf(defId: string): string | null {
  return costs.get(defId) ?? null;
}

/** A character's printed Power, HP, Range and Move. Null for anything that is not one. */
export function statsOf(
  defId: string,
): { power: number; hp: number; range: number; move: number } | null {
  return stats.get(defId) ?? null;
}

/**
 * Does this card stay on the table once opened? Rules.md §3 — characters and
 * Eternal effects do; a Normal resolves and goes to the graveyard.
 */
export function staysOnTable(defId: string): boolean {
  return permanent.has(defId);
}

/** The card's colour, which is what it can pay toward. */
export function colourOf(defId: string): string | null {
  return colours.get(defId) ?? null;
}

/**
 * Loads the names once and re-renders when they land, so a board drawn
 * before the fetch finished does not sit there showing ids.
 */
export function useCardNames(): void {
  const [, setLoaded] = useState(names !== null);

  useEffect(() => {
    if (names !== null) return;
    let live = true;
    inFlight ??= load();
    void inFlight
      .then(() => live && setLoaded(true))
      // Names are a nicety; ids still work. Nothing here should break a match.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
}
