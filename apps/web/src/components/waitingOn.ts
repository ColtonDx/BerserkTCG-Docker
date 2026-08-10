import type { PlayerId, PlayerView } from '@berserk/engine';

/**
 * Which seat the game is actually waiting on, or null if it is waiting on
 * nobody.
 *
 * "Whose turn is it" is not the same question. A defender opens, commits and
 * assigns damage throughout the *attacker's* turn (Rules.md §11), a Quick
 * window names its own responder whoever's turn it is (§13), and an effect
 * that stopped to ask outranks both. So the seat holding the decision is
 * frequently not the seat holding priority.
 *
 * The precedence here deliberately mirrors `legalActions` in the engine — the
 * pending choice first, then the Quick window, then a running battle, then
 * ordinary priority. That is not a coincidence to be tidied away: the engine
 * is the authority on who may act, and a glow that disagreed with it would be
 * pointing at a player who cannot do anything.
 *
 * Returns null once the match is over, and during setup, where both players
 * decide their opening hand independently (§9.4) and neither is being waited
 * on by the other.
 */
export function waitingOn(view: PlayerView): PlayerId | null {
  if (view.status.kind !== 'playing') return null;
  if (view.pending) return view.pending.waitingOn;
  if (view.quick) return view.quick.waitingOn;
  if (view.battle) return view.battle.waitingOn;
  return view.turn.priorityPlayer;
}
