/**
 * @berserk/engine — the authoritative rules engine.
 *
 * Pure and deterministic: no I/O, no timers, no `Math.random()`. It knows
 * nothing about sockets, HTTP, React, or the database. That isolation is what
 * lets the same code run the server, the replay viewer, and the test suite.
 *
 * Rules are implemented from `Rules.md`; product behaviour from
 * `DesignNotes.md`. Comments cite the section they come from.
 */

export * from './ids.js';
export * from './result.js';
export * from './rng.js';
export * from './cards.js';
export * from './abilities.js';
export * from './types.js';
export * from './zones.js';
export * from './rules.js';
export * from './setup.js';
export * from './reducer.js';
export * from './legal.js';
export * from './view.js';
export * from './engine.js';
export { PLACEHOLDER_CARDS, placeholderDeck } from './data/placeholder-cards.js';
export * from './data/catalogue.js';
export * from './deck.js';
export * from './data/registry.js';
