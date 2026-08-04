import type { CardRegistry } from './cards.js';
import type { PlayerId } from './ids.js';
import { legalActions } from './legal.js';
import { reduce, reduceAll, type ReduceResult } from './reducer.js';
import type { EngineContext } from './rules.js';
import { createMatch, type MatchConfig } from './setup.js';
import type { GameAction, GameState, PlayerAction } from './types.js';
import { viewFor, type PlayerView } from './view.js';

/**
 * Convenience wrapper that carries the card registry so callers don't have to
 * thread an `EngineContext` through every call. Purely ergonomic — the
 * underlying functions stay pure and are still exported directly for tests.
 */
export interface Engine {
  readonly ctx: EngineContext;
  createMatch(config: Omit<MatchConfig, 'registry'>): GameState;
  reduce(state: GameState, actor: PlayerId, action: GameAction): ReduceResult;
  reduceAll(state: GameState, actions: readonly PlayerAction[]): ReduceResult;
  legalActions(state: GameState, player: PlayerId): GameAction[];
  viewFor(state: GameState, player: PlayerId): PlayerView;
}

export function createEngine(registry: CardRegistry): Engine {
  const ctx: EngineContext = { registry };

  return {
    ctx,
    createMatch: (config) => createMatch({ ...config, registry }),
    reduce: (state, actor, action) => reduce(ctx, state, actor, action),
    reduceAll: (state, actions) => reduceAll(ctx, state, actions),
    legalActions: (state, player) => legalActions(ctx, state, player),
    viewFor: (state, player) => viewFor(ctx, state, player),
  };
}
