import type { PlayerId, PlayerView } from '@berserk/engine';
import type { JSX } from 'react';
import femto from '../../../../art-assets/Femto.jpg';
import { cardArt } from './CardImage.js';

/**
 * A player, as a badge: icon, name, and — on demand — how the game is
 * actually going for them.
 *
 * There is no number in the badge because **Berserk has no life totals**
 * (Rules.md §1: you win by occupying cities or by decking your opponent, and
 * `PlayerState` has no such field). The nearest thing to a score is cities
 * held, which is the win condition itself, so that is what the stats overlay
 * puts here — three of them including the Royal Capital ends the match.
 *
 * The ring lights when it is that player's turn, which is the one piece of
 * state worth showing without being asked for.
 */

interface Props {
  readonly view: PlayerView;
  readonly player: PlayerId | undefined;
  readonly side: 'top' | 'bottom';
  /** Reveal the numbers. See `useStatsKey`. */
  readonly stats: boolean;
  /**
   * Turns the counts on and off. Given only to your own badge: holding
   * Control does the same thing, and a touchscreen has no Control.
   */
  readonly onToggleStats?: (() => void) | undefined;
}

export function Nameplate({ view, player, side, stats, onToggleStats }: Props): JSX.Element | null {
  if (!player) return null;
  const state = view.players[player];
  if (!state) return null;

  const active = view.turn.activePlayer === player;
  const cities = view.cities.filter((city) => city.occupiedBy === player).length;
  const classes = ['nameplate', `nameplate--${side}`, `nameplate--${seatColour(view, player)}`];
  if (active) classes.push('nameplate--active');
  if (!state.connected) classes.push('nameplate--away');

  if (onToggleStats) classes.push('nameplate--switch');

  return (
    <div
      className={classes.join(' ')}
      {...(onToggleStats
        ? {
            role: 'button',
            tabIndex: 0,
            'aria-pressed': stats,
            'aria-label': 'Show counts',
            onClick: onToggleStats,
          }
        : {})}
    >
      <div className="nameplate__disc" aria-hidden="true">
        {/* The computer opponent has a face of its own; a player has whatever
            card they picked in Settings, and an initial until they pick. */}
        {state.name === 'Femto' ? (
          <img className="nameplate__face" src={femto} alt="" />
        ) : state.icon ? (
          <img className="nameplate__face nameplate__face--card" src={cardArt(state.icon)} alt="" />
        ) : (
          <span className="nameplate__initial">{initial(state.name)}</span>
        )}
        {stats && <span className="nameplate__cities">{cities}</span>}
      </div>
      <span className="nameplate__name">
        {state.connected ? state.name : `${state.name} · away`}
      </span>
    </div>
  );
}

const initial = (name: string): string => name.trim().charAt(0).toUpperCase() || '?';

/**
 * Each seat's colour, taken from seat order rather than from who is looking.
 * Both players then see the same person in the same colour, which is what
 * makes it useful for reading who holds which city.
 */
export function seatColour(view: PlayerView, player: PlayerId): 'red' | 'blue' {
  return view.seats.indexOf(player) === 0 ? 'red' : 'blue';
}
