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
  /** Read a card properly — art, rules text and stats. */
  readonly onInspect: (defId: string) => void;
}

export function PileViewer({ view, player, onClose, onPeek, onInspect }: Props): JSX.Element {
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
              // A button, not a div: clicking a card here reads it, the same
              // as everywhere else. The cursor already promised `zoom-in` and
              // the only way to see one was a two-second press — long enough
              // with a mouse that the pile looked as though it did nothing.
              <button
                type="button"
                key={card.instanceId}
                className="viewer__card"
                title={`Read ${nameOf(card.defId)}`}
                onClick={() => {
                  // A hold ends in a click too; that one is not a request to
                  // open the reader on top of the card already held up.
                  if (peek.consumed()) return;
                  onInspect(card.defId);
                }}
                {...peek.bind(card.defId)}
              >
                <CardImage defId={card.defId} className="viewer__art" />
              </button>
            ))}
          </div>
        )}

        <p className="viewer__hint">Click a card to read it, or hold to see it up close.</p>
      </div>
      <button type="button" className="viewer__scrim" aria-label="Close" onClick={onClose} />
    </div>
  );
}
