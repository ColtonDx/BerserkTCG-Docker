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
  readonly type: string | null;
  readonly duration: string | null;
  readonly effect: string | null;
  readonly subtypes: readonly string[];
  /** Whether the engine carries this card's behaviour yet. Rules.md §13. */
  readonly implemented?: boolean;
}

const costs = new Map<string, string>();
const texts = new Map<string, string>();
const implemented = new Set<string>();
const subtypes = new Map<string, readonly string[]>();
const colours = new Map<string, string>();
const stats = new Map<string, { power: number; hp: number; range: number }>();
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
    if (card.subtypes.length > 0) subtypes.set(card.id, card.subtypes);
    if (card.color) colours.set(card.id, card.color);
    // Rules.md §3 — a Normal effect resolves and goes to the Trash; a
    // character or an Eternal stays where it was opened.
    if (card.type === 'character' || card.duration === 'eternal') permanent.add(card.id);
    if (card.power !== null && card.hp !== null && card.range !== null) {
      stats.set(card.id, { power: card.power, hp: card.hp, range: card.range });
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

/** A character's printed Power, HP and Range. Null for anything that is not one. */
export function statsOf(defId: string): { power: number; hp: number; range: number } | null {
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
