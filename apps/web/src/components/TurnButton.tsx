import type { GameAction, PlayerView } from '@berserk/engine';
import type { JSX } from 'react';

/**
 * The one button the turn actually needs, floating over the bottom-right of
 * the table.
 *
 * It replaced a full-width bar that spent most of its height restating what
 * the phase track already showed. Floating it gives that space back to the
 * board, which is the thing worth looking at.
 *
 * When it is not your move the button is gone and only a quiet caption
 * remains, so the corner never invites a click that would be rejected.
 */

interface Props {
  readonly view: PlayerView;
  readonly onAction: (action: GameAction) => void;
  readonly disabled?: boolean;
}

export function TurnButton({ view, onAction, disabled = false }: Props): JSX.Element | null {
  if (view.status.kind === 'finished') return null;

  // Responding to something beats ending the phase. Rules.md §14.
  const pass = view.legalActions.find((action) => action.type === 'PASS_PRIORITY');
  const end = view.legalActions.find((action) => action.type === 'END_PHASE');
  const action = pass ?? end;

  if (!action) {
    const waiting = waitingLine(view);
    return waiting ? <p className="turn-button__waiting">{waiting}</p> : null;
  }

  const phase = view.phases[view.turn.phaseIndex];

  return (
    <button
      type="button"
      className="turn-button"
      disabled={disabled}
      onClick={() => onAction(action)}
    >
      <span className="turn-button__label">
        {action.type === 'PASS_PRIORITY' ? 'Pass' : 'Next'}
      </span>
      {action.type === 'END_PHASE' && phase && (
        <span className="turn-button__phase">end {phase.name.toLowerCase()}</span>
      )}
    </button>
  );
}

function waitingLine(view: PlayerView): string | null {
  if (view.status.kind === 'setup') {
    return view.mulliganPending.includes(view.viewer)
      ? null // the hand overlay is already saying so, far more loudly
      : 'Waiting for your opponent to settle their hand…';
  }
  return view.turn.activePlayer === view.viewer ? null : 'Waiting for opponent…';
}
