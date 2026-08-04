import type { GameAction, PlayerView, QuickTrigger } from '@berserk/engine';
import { isHidden } from '@berserk/engine';
import type { JSX } from 'react';
import { CardImage } from './CardImage.js';
import { costOf, nameOf } from '../state/useCardNames.js';
import { usePeek } from './usePeek.js';

/**
 * "They just did that — do you want to answer?"
 *
 * Rules.md §13 lets a Quick interject almost anywhere, and asking after every
 * action is how a game becomes a dialogue box. So this only ever appears at
 * the six moments in `DesignNotes`, and only when the player actually has a
 * Quick set and can pay for it — which is what makes it meaningful when it
 * does appear. If it is on screen, there is a real decision behind it.
 *
 * It is a hard stop: the game is frozen behind it until it is answered, so
 * there is no cancel, only "open one" or "not now".
 */

const BECAUSE: Record<QuickTrigger, string> = {
  turnStart: 'Their turn has begun.',
  cardOpened: 'They opened a card.',
  mainPhase: 'They have reached their Main phase.',
  combat: 'They have declared a battle.',
  attack: 'They are attacking.',
  turnEnd: 'They are ending their turn.',
};

interface Props {
  readonly view: PlayerView;
  readonly trigger: QuickTrigger;
  /** Consider opening one — the player still has to pay for it. */
  readonly onConsiderOpen: (action: Extract<GameAction, { type: 'OPEN_CARD' }>) => void;
  readonly onPass: () => void;
  readonly onPeek: (defId: string | null) => void;
}

export function QuickWindow({ view, trigger, onConsiderOpen, onPass, onPeek }: Props): JSX.Element {
  const peek = usePeek(onPeek);
  const opens = view.legalActions.filter(
    (action): action is Extract<GameAction, { type: 'OPEN_CARD' }> => action.type === 'OPEN_CARD',
  );

  return (
    <div className="focus quickwin" role="dialog" aria-modal="true">
      <div className="focus__panel">
        <h2 className="focus__title">Quick</h2>
        <p className="focus__hint">
          {BECAUSE[trigger]} You may open a Quick card now, out of turn.
        </p>

        <div className="focus__hand">
          {opens.map((action) => {
            const card = view.cards[action.card];
            const defId = card && !isHidden(card) ? String(card.defId) : null;
            if (!defId) return null;
            const cost = costOf(defId);
            return (
              <button
                key={action.card}
                type="button"
                className="focus__card"
                onClick={() => onConsiderOpen(action)}
                {...peek.bind(defId)}
              >
                <CardImage defId={defId} className="focus__art" />
                <span className="focus__name">{nameOf(defId)}</span>
                {cost && <span className="quickwin__cost">{cost}</span>}
              </button>
            );
          })}
        </div>

        <div className="focus__actions">
          <button type="button" className="btn btn--primary" onClick={onPass}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
