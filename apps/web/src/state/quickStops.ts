import type { PlayerView, QuickTrigger } from '@berserk/engine';

/**
 * When a Quick window stops the game to ask, and when the client answers
 * "not now" on the player's behalf.
 *
 * The engine only ever opens a window when there is a real decision in it —
 * a Quick set, payable, and worth something at this moment (`rules.ts:
 * quickRelevant`). Even so, a player holding a draw-two would be asked at
 * every turn edge, and the settings here are how they say how often they
 * want that. The engine still stops; the client passes for them.
 *
 * Per browser, like sound: it is a preference about being interrupted, not
 * a fact about the account.
 */

export type QuickStops = 'battles' | 'always' | 'never';

const KEY = 'berserk:quickStops';

export const DEFAULT_STOPS: QuickStops = 'battles';

export function quickStops(): QuickStops {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === 'always' || stored === 'never' ? stored : DEFAULT_STOPS;
  } catch {
    return DEFAULT_STOPS;
  }
}

export function setQuickStops(stops: QuickStops): void {
  try {
    if (stops === DEFAULT_STOPS) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, stops);
  } catch {
    // A browser that refuses storage keeps the default.
  }
}

/**
 * Is this window one the game should stop dead for?
 *
 * A battle is where a Quick decides something: the moments inside one —
 * the declaration, the vanguard stepping forward, a card opened in the
 * contested city, the last chance before damage — are a hard stop. The
 * turn's edges and the Main phase are not, and a window there counts down
 * to a pass unless the player wants to be asked every time.
 */
export function isCombatWindow(trigger: QuickTrigger, view: PlayerView): boolean {
  switch (trigger) {
    case 'combat':
    case 'attack':
    case 'beforeDamage':
      return true;
    case 'cardOpened':
      return view.battle !== null;
    case 'turnStart':
    case 'mainPhase':
    case 'turnEnd':
      return false;
  }
}

/** How a window should be put to the player, given their setting. */
export type Manner =
  /** Wait for an answer. */
  | 'stop'
  /** Ask, and pass on their behalf if they do not answer in time. */
  | 'countdown'
  /** Pass for them, saying so briefly. */
  | 'auto';

export function mannerOf(trigger: QuickTrigger, view: PlayerView, stops: QuickStops): Manner {
  if (stops === 'never') return 'auto';
  if (isCombatWindow(trigger, view)) return 'stop';
  return stops === 'always' ? 'countdown' : 'auto';
}
