import { describe, expect, it } from 'vitest';
import { CATALOGUE, CATALOGUE_BY_ID, MERCENARIES, SET_CODES, cardsInSet } from './catalogue.js';

/** Printed set sizes, matching Konami's original runs. */
const SET_SIZES: Record<string, number> = {
  BK1: 160,
  BK2: 64,
  BK3: 64,
  BK4: 80,
  BK5: 80,
};

describe('card catalogue', () => {
  it('holds every card from all five sets', () => {
    expect(CATALOGUE).toHaveLength(448);
    expect(SET_CODES).toEqual(['BK1', 'BK2', 'BK3', 'BK4', 'BK5']);
    for (const [code, size] of Object.entries(SET_SIZES)) {
      expect(cardsInSet(code), code).toHaveLength(size);
    }
  });

  it('numbers each set contiguously from 1 with no duplicates', () => {
    for (const [code, size] of Object.entries(SET_SIZES)) {
      const numbers = cardsInSet(code).map((card) => card.number);
      expect(numbers, code).toEqual(Array.from({ length: size }, (_, i) => i + 1));
    }
  });

  it('gives every card an id matching its set and number', () => {
    for (const card of CATALOGUE) {
      expect(card.id).toBe(`${card.set}-${String(card.number).padStart(3, '0')}`);
      expect(card.image).toBe(`cards/${card.id}.jpg`);
      expect(CATALOGUE_BY_ID.get(card.id)).toBe(card);
    }
  });

  it('assigns a colour to every card, evenly split four ways', () => {
    const counts = { white: 0, green: 0, black: 0, red: 0 };
    for (const card of CATALOGUE) {
      expect(card.color, card.id).not.toBeNull();
      counts[card.color as keyof typeof counts]++;
    }
    // 448 cards, four colours, exactly a quarter each.
    expect(counts).toEqual({ white: 112, green: 112, black: 112, red: 112 });
  });

  it('lays each set out as four equal colour blocks', () => {
    for (const [code, size] of Object.entries(SET_SIZES)) {
      const cards = cardsInSet(code);
      const block = size / 4;
      const order = ['white', 'green', 'black', 'red'];
      for (const card of cards) {
        const expected = order[Math.floor((card.number - 1) / block)];
        expect(card.color, `${card.id}`).toBe(expected);
      }
    }
  });

  it('has exactly one Mercenary per colour per set — 20 in all', () => {
    expect(MERCENARIES).toHaveLength(20);

    for (const [code, size] of Object.entries(SET_SIZES)) {
      const mercs = cardsInSet(code).filter((card) => card.mercenary);
      expect(mercs, code).toHaveLength(4);
      // The Mercenary is the first card of each colour block.
      expect(mercs.map((m) => m.number)).toEqual([
        1,
        size / 4 + 1,
        size / 2 + 1,
        (size * 3) / 4 + 1,
      ]);
      expect(mercs.map((m) => m.color)).toEqual(['white', 'green', 'black', 'red']);
      expect(mercs.every((m) => m.name === 'Mercenary')).toBe(true);
    }
  });

  it('reads printed numbers within their real ranges', () => {
    // A broken read would scatter values across every digit; these stay in the
    // narrow bands the printed cards actually use.
    for (const card of CATALOGUE) {
      if (card.level !== null) expect(card.level, `${card.id} level`).toBeLessThanOrEqual(6);
      if (card.power !== null) expect(card.power, `${card.id} power`).toBeLessThanOrEqual(9);
      if (card.hp !== null) expect(card.hp, `${card.id} hp`).toBeLessThanOrEqual(9);
      if (card.movement !== null) expect(card.movement, `${card.id} move`).toBeLessThanOrEqual(5);
      if (card.range !== null) expect(card.range, `${card.id} range`).toBeLessThanOrEqual(5);
    }
  });

  it('gives combat stats only to Character cards', () => {
    // Effect cards have no stat boxes; their text runs the full width.
    for (const card of CATALOGUE) {
      const stats = [card.power, card.hp, card.range, card.movement];
      if (stats.some((v) => v !== null)) {
        expect(card.character, `${card.id} has stats but is not a character`).not.toBe(false);
      }
      if (card.character) expect(card.type, card.id).toBe('character');
    }
  });

  it('matches the values verified by eye on known cards', () => {
    const known: Record<string, Partial<Record<string, number>>> = {
      'BK1-007': { level: 1, range: 0, movement: 2, power: 1, hp: 2 },
      'BK1-001': { level: 0, range: 0, movement: 1, power: 1, hp: 1 },
      'BK4-048': { level: 1, range: 1, movement: 2, power: 1, hp: 2 },
      'BK5-026': { level: 2, range: 0, movement: 1, power: 3, hp: 3 },
    };
    for (const [id, fields] of Object.entries(known)) {
      const card = CATALOGUE_BY_ID.get(id);
      expect(card, id).toBeDefined();
      for (const [field, value] of Object.entries(fields)) {
        expect(card?.[field as keyof typeof card], `${id} ${field}`).toBe(value);
      }
    }
  });

  it('knows every card by name, cost and Level', () => {
    // These come from Docs/Berserk_TCG_Cardlist.csv. Cost and Level together
    // are what let a card be opened at all (Rules.md §7), so a gap here takes
    // a card out of the game.
    expect(CATALOGUE.every((card) => card.name !== null && card.name !== '')).toBe(true);
    expect(CATALOGUE.every((card) => card.cost !== null)).toBe(true);
    expect(CATALOGUE.every((card) => card.level !== null)).toBe(true);
  });

  it('gives every character its combat numbers, and no others any', () => {
    // Only a Character card has a Range/Move/Pow/HP panel. Blank on an Effect
    // card is the honest value; a zero would read as a real number.
    for (const card of CATALOGUE) {
      const stats = [card.power, card.hp, card.range, card.movement];
      const expected = card.character
        ? stats.every((v) => v !== null)
        : stats.every((v) => v === null);
      expect(expected, `${card.id} (${card.name ?? '?'})`).toBe(true);
    }
  });

  it('marks the Unique cards, and agrees with itself by name', () => {
    // Uniqueness is a property of the name (Rules.md §8), so every printing of
    // a name has to carry the same flag — otherwise which copy you drew would
    // decide whether the rule applied.
    const unique = CATALOGUE.filter((card) => card.unique);
    expect(unique.length).toBeGreaterThan(100);

    const byName = new Map<string, boolean[]>();
    for (const card of CATALOGUE) {
      if (!card.name) continue;
      byName.set(card.name, [...(byName.get(card.name) ?? []), card.unique]);
    }
    for (const [name, flags] of byName) {
      expect(new Set(flags).size, `${name} is marked both ways`).toBe(1);
    }
  });

  it('knows what each card is, and which Effects stay on the table', () => {
    // Rules.md §3 — a Normal resolves and goes to the Trash, an Eternal stays.
    // Getting this from the type line rather than from whether a stats panel
    // was found is what makes it a fact instead of an inference.
    for (const card of CATALOGUE) {
      if (card.character) {
        expect(card.type, card.id).toBe('character');
        expect(card.duration, card.id).toBeNull();
        expect(card.quick, `${card.id}: a character cannot be Quick`).toBe(false);
      } else {
        expect(card.type, card.id).toBe('effect');
        expect(['normal', 'eternal']).toContain(card.duration);
        // §13 — Quick is a kind of Normal; an Eternal sits on the table.
        if (card.quick) expect(card.duration, card.id).toBe('normal');
      }
    }
    expect(CATALOGUE.filter((c) => c.duration === 'eternal').length).toBeGreaterThan(0);
    expect(CATALOGUE.filter((c) => c.quick).length).toBeGreaterThan(0);
  });

  it('still admits what it does not know', () => {
    // A wrong value here would silently corrupt deck legality and play, so the
    // database must admit its gaps: a card whose rules text has not been
    // transcribed says `null` rather than an empty string that would read as
    // "this card does nothing". Tighten this as fields land.
    const transcribed = CATALOGUE.filter((card) => card.effect !== null);
    expect(transcribed.length).toBeGreaterThan(0);
    expect(transcribed.every((card) => card.effect !== '')).toBe(true);
    expect(CATALOGUE.some((card) => card.effect === null)).toBe(true);
  });

  it('splits a character’s type line into subtype tokens', () => {
    // Abilities name one token at a time — "other Hawk characters" — so the
    // printed `Hawks/Cavalry` has to arrive as separate words.
    const griffith = CATALOGUE.find((card) => card.id === 'BK1-010');
    expect(griffith?.subtypes).toEqual(['hawk', 'leader']);

    // The Neo Band is not the Band. A Hawk ability that swept them up would
    // be wrong in a way nothing else would catch.
    const neo = CATALOGUE.filter((card) => card.subtypes.includes('neohawk'));
    expect(neo.length).toBeGreaterThan(0);
    expect(neo.every((card) => !card.subtypes.includes('hawk'))).toBe(true);

    // Effect cards carry a duration on that line instead, not a subtype.
    expect(
      CATALOGUE.filter((card) => card.type === 'effect').every((c) => c.subtypes.length === 0),
    ).toBe(true);
  });
});
