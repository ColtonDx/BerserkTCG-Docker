import { CardRegistry, parseCost, type CardDefinition } from '../cards.js';
import { asCardDefId } from '../ids.js';
import { abilitiesFor } from '../abilities.js';
import { CATALOGUE, type CatalogueCard } from './catalogue.js';

/**
 * Turns the card database into definitions the engine can play with.
 *
 * Only what has actually been read off the cards is carried across. Where a
 * field is missing it stays missing — `cost` and `level` are nullable for
 * exactly this reason, and a card without them cannot be opened. Substituting
 * a default would let illegal plays through quietly, which is worse than a
 * card that refuses to open and says why.
 */

function toDefinition(card: CatalogueCard): CardDefinition {
  const isCharacter = card.type === 'character';
  const stats =
    isCharacter && card.power !== null && card.hp !== null
      ? {
          move: card.movement ?? 0,
          range: card.range ?? 0,
          power: card.power,
          hp: card.hp,
        }
      : undefined;

  const definition: CardDefinition = {
    id: asCardDefId(card.id),
    // The printed name is not captured for most cards; the card number is a
    // stable stand-in and is what the art is keyed by anyway.
    name: card.name ?? card.id,
    kind: isCharacter ? 'character' : 'effect',
    color: card.color ?? 'white',
    level: card.level,
    cost: card.cost === null ? null : parseCost(card.cost),
    set: card.set,
    cardNo: card.id,
    art: card.image,
    ...(stats ? { stats } : {}),
    // Read off the type line, not guessed. Whether an Effect is Normal or
    // Eternal decides whether it stays on the table after resolving, so a
    // default here would be a rules decision made by accident. Rules.md §3.
    ...(isCharacter ? {} : { duration: card.duration === 'eternal' ? 'eternal' : 'normal' }),
    ...(card.unique ? { unique: true } : {}),
    ...(card.quick ? { quick: true } : {}),
    ...(card.subtypes.length > 0 ? { subtypes: card.subtypes } : {}),
    ...(card.effect ? { text: card.effect } : {}),
    ...(abilitiesFor(card.id).length > 0 ? { abilities: abilitiesFor(card.id) } : {}),
  };
  return definition;
}

/** Every real card, as engine definitions. Built once. */
let cached: CardRegistry | null = null;

export function catalogueRegistry(): CardRegistry {
  cached ??= new CardRegistry(CATALOGUE.map(toDefinition));
  return cached;
}

/** How much of the database a match can actually use. For diagnostics. */
export function playableCoverage(): { total: number; openable: number; characters: number } {
  return {
    total: CATALOGUE.length,
    // A card can only be opened once both its level and cost are known.
    openable: CATALOGUE.filter((card) => card.level !== null && card.cost !== null).length,
    characters: CATALOGUE.filter((card) => card.character).length,
  };
}
