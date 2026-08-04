import { isHidden, type PlayerView, type VisibleCard } from '@berserk/engine';
import { useEffect, type JSX } from 'react';
import { CardImage } from './CardImage.js';
import { usePeek } from './usePeek.js';
import { nameOf } from '../state/useCardNames.js';

/**
 * Everything in a graveyard.
 *
 * The Trash is public in full (Rules.md §15), so either player's can be opened
 * — and opening one tells nobody: it reads the view the server already sent
 * and submits nothing.
 *
 * Most recent first, because that is the order players ask the question in.
 */

interface Props {
  readonly view: PlayerView;
  readonly player: string;
  readonly onClose: () => void;
  readonly onPeek: (defId: string | null) => void;
}

export function PileViewer({ view, player, onClose, onPeek }: Props): JSX.Element {
  const peek = usePeek(onPeek);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const cards = [...(view.zoneOrder[`${player}:trash`] ?? [])]
    .reverse()
    .map((id) => view.cards[id])
    .filter((card): card is VisibleCard => card !== undefined && !isHidden(card));

  const whose = player === view.viewer ? 'Your' : "Opponent's";

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={`${whose} graveyard`}>
      <div className="viewer__panel" onClick={(event) => event.stopPropagation()}>
        <header className="viewer__head">
          <h2 className="viewer__title">
            {whose} graveyard <span className="viewer__count">{cards.length}</span>
          </h2>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </header>

        {cards.length === 0 ? (
          <p className="viewer__empty">Nothing here yet.</p>
        ) : (
          <div className="viewer__grid">
            {cards.map((card) => (
              <div
                key={card.instanceId}
                className="viewer__card"
                title={nameOf(card.defId)}
                {...peek.bind(card.defId)}
              >
                <CardImage defId={card.defId} className="viewer__art" />
              </div>
            ))}
          </div>
        )}

        <p className="viewer__hint">Hold a card to see it up close.</p>
      </div>
      <button type="button" className="viewer__scrim" aria-label="Close" onClick={onClose} />
    </div>
  );
}
