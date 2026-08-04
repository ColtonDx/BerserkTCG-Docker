import { describe, expect, it } from 'vitest';
import { createRng, nextFloat, nextInt, pick, shuffle } from './rng.js';

describe('rng', () => {
  it('produces the same sequence for the same seed', () => {
    const draw = (seed: number) => {
      let rng = createRng(seed);
      return Array.from({ length: 10 }, () => {
        const next = nextFloat(rng);
        rng = next.rng;
        return next.value;
      });
    };
    expect(draw(7)).toEqual(draw(7));
    expect(draw(7)).not.toEqual(draw(8));
  });

  it('stays within [0, 1)', () => {
    let rng = createRng(123);
    for (let i = 0; i < 1000; i++) {
      const next = nextFloat(rng);
      rng = next.rng;
      expect(next.value).toBeGreaterThanOrEqual(0);
      expect(next.value).toBeLessThan(1);
    }
  });

  it('bounds nextInt correctly', () => {
    let rng = createRng(9);
    for (let i = 0; i < 500; i++) {
      const next = nextInt(rng, 6);
      rng = next.rng;
      expect(Number.isInteger(next.value)).toBe(true);
      expect(next.value).toBeGreaterThanOrEqual(0);
      expect(next.value).toBeLessThan(6);
    }
  });

  it('shuffles as a permutation without mutating the input', () => {
    const input = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);
    const { items } = shuffle(input, createRng(3));

    expect(items).toHaveLength(input.length);
    expect([...items].sort((a, b) => a - b)).toEqual([...input]);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('shuffles deterministically per seed', () => {
    const deck = Array.from({ length: 40 }, (_, i) => i);
    expect(shuffle(deck, createRng(11)).items).toEqual(shuffle(deck, createRng(11)).items);
  });

  it('picks only from the given items', () => {
    const { item } = pick(['a', 'b', 'c'], createRng(5));
    expect(['a', 'b', 'c']).toContain(item);
  });

  it('rejects empty inputs', () => {
    expect(() => pick([], createRng(1))).toThrow();
    expect(() => nextInt(createRng(1), 0)).toThrow();
  });
});
