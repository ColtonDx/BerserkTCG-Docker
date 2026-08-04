/**
 * Branded id types. These are plain strings at runtime, but the brand keeps a
 * `CardInstanceId` from being passed where a `PlayerId` is expected.
 */
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** A seat in a match. Stable for the life of the match. */
export type PlayerId = Brand<string, 'PlayerId'>;
/** A match/room identifier. */
export type MatchId = Brand<string, 'MatchId'>;
/** A card *definition* (printed card), e.g. `base-swamp-troll`. */
export type CardDefId = Brand<string, 'CardDefId'>;
/** A single physical card in a match. Two copies of one definition get two of these. */
export type CardInstanceId = Brand<string, 'CardInstanceId'>;

export const asPlayerId = (v: string): PlayerId => v as PlayerId;
export const asMatchId = (v: string): MatchId => v as MatchId;
export const asCardDefId = (v: string): CardDefId => v as CardDefId;
export const asCardInstanceId = (v: string): CardInstanceId => v as CardInstanceId;
