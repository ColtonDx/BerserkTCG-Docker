/**
 * Deterministic RNG.
 *
 * Every random decision in a match (shuffles, coin flips, random targeting)
 * MUST go through here. The generator state lives inside `GameState`, so a
 * match is fully reproducible from `{ seed, actions[] }` — which is what makes
 * replays, spectating, and bug reports work.
 *
 * Never call `Math.random()` anywhere in this package.
 */

/** mulberry32 — small, fast, good enough for card shuffling. */
export interface Rng {
  /** Opaque generator state. Serializable; store it in `GameState`. */
  readonly state: number;
}

export function createRng(seed: number): Rng {
  return { state: seed >>> 0 };
}

/** Returns the next float in [0, 1) plus the advanced generator. */
export function nextFloat(rng: Rng): { value: number; rng: Rng } {
  let t = (rng.state + 0x6d2b79f5) >>> 0;
  const next = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: { state: next } };
}

/** Returns an integer in [0, maxExclusive). */
export function nextInt(rng: Rng, maxExclusive: number): { value: number; rng: Rng } {
  if (maxExclusive <= 0) throw new Error('nextInt requires maxExclusive > 0');
  const { value, rng: advanced } = nextFloat(rng);
  return { value: Math.floor(value * maxExclusive), rng: advanced };
}

/** Fisher-Yates. Returns a new array; does not mutate the input. */
export function shuffle<T>(items: readonly T[], rng: Rng): { items: T[]; rng: Rng } {
  const out = [...items];
  let current = rng;
  for (let i = out.length - 1; i > 0; i--) {
    const { value: j, rng: advanced } = nextInt(current, i + 1);
    current = advanced;
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return { items: out, rng: current };
}

/** Picks one element uniformly at random. */
export function pick<T>(items: readonly T[], rng: Rng): { item: T; rng: Rng } {
  if (items.length === 0) throw new Error('pick requires a non-empty array');
  const { value, rng: advanced } = nextInt(rng, items.length);
  return { item: items[value] as T, rng: advanced };
}
