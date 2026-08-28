import type { PlayerView } from '@berserk/engine';
import type { JSX } from 'react';

/**
 * The result, once the match is over.
 *
 * This used to be a line of text in the bottom bar. Losing the bar meant the
 * result needed somewhere to go, and the end of a game deserves more than a
 * line — so it takes the screen.
 *
 * Playing again does *not* re-challenge the same opponent: there is no way to
 * ask them and no message to ask with. Against the computer it starts a fresh
 * match outright, which is a real rematch; against a person it goes looking
 * for another one. Offering to a seat that cannot answer would be worse than
 * not offering.
 */

const REASON: Record<string, string> = {
  occupation: 'by occupation of the Royal Capital',
  deck_out: 'by running the deck out',
  concede: 'by concession',
};

interface Props {
  readonly view: PlayerView;
  readonly onLeave: () => void;
  /** Start another match of the same kind, without going back to the menu. */
  readonly onAgain: () => void;
  /** True when the opponent was the computer, which can always play again. */
  readonly solo: boolean;
  /** The last exchange is still being drawn; the result waits for it. */
  readonly busy?: boolean;
}

export function MatchOver({
  view,
  onLeave,
  onAgain,
  solo,
  busy = false,
}: Props): JSX.Element | null {
  if (view.status.kind !== 'finished' || busy) return null;

  const { winner, reason } = view.status;
  const outcome = winner === null ? 'Draw' : winner === view.viewer ? 'Victory' : 'Defeat';

  return (
    <div className="over" role="dialog" aria-modal="true" aria-label={outcome}>
      <div className="over__panel">
        <h2 className={winner === view.viewer ? 'over__title over__title--win' : 'over__title'}>
          {outcome}
        </h2>
        <p className="over__reason">{REASON[reason] ?? reason}</p>
        <div className="over__actions">
          <button type="button" className="btn btn--primary" onClick={onAgain}>
            {solo ? 'Play again' : 'Find another match'}
          </button>
          <button type="button" className="btn" onClick={onLeave}>
            Main menu
          </button>
        </div>
      </div>
    </div>
  );
}
