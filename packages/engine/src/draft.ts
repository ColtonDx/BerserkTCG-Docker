/**
 * The reducer works on a deep-mutable copy of `GameState` and returns it as
 * the next immutable state. Copying whole states is fine at TCG scale (a few
 * hundred cards) and buys us structural sharing bugs we never have to debug.
 */

type Primitive = string | number | boolean | bigint | symbol | null | undefined;

/**
 * Deeply strips `readonly`. Primitives pass through untouched — branded ids
 * are `string & {…}` intersections, so they must be matched before the object
 * case or the mapped type would shred them.
 */
export type Draft<T> = T extends Primitive
  ? T
  : T extends readonly (infer U)[]
    ? Draft<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: Draft<T[K]> }
      : T;

export function toDraft<T>(value: T): Draft<T> {
  return structuredClone(value) as Draft<T>;
}
