import { useEffect, type JSX } from 'react';
import { CardImage } from './CardImage.js';
import { implementedIn, nameOf, subtypesOf, textOf } from '../state/useCardNames.js';

/**
 * A card at readable size.
 *
 * The table shows cards far too small to read, so inspecting one is a basic
 * need rather than a nicety — it is the first entry on every card's menu.
 */

interface Props {
  readonly defId: string;
  readonly onClose: () => void;
}

export function Inspect({ defId, onClose }: Props): JSX.Element {
  const text = textOf(defId);
  const subtypes = subtypesOf(defId);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="inspect"
      role="dialog"
      aria-modal="true"
      aria-label={`Card ${nameOf(defId)}`}
      onClick={onClose}
    >
      <div className="inspect__frame" onClick={(event) => event.stopPropagation()}>
        <CardImage defId={defId} className="inspect__art" />
        <div className="inspect__foot">
          <span className="inspect__id">
            {nameOf(defId)} <span className="inspect__number">{defId}</span>
            {subtypes.length > 0 && (
              <span className="inspect__subtypes">{subtypes.join(' · ')}</span>
            )}
          </span>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
        {text !== null && (
          <p
            className={
              implementedIn(defId) ? 'inspect__text' : 'inspect__text inspect__text--inert'
            }
          >
            {text}
            {/* Most of the set has no behaviour written yet (Rules.md §13).
             * Saying so beats letting a player plan around an ability that
             * will not happen. */}
            {!implementedIn(defId) && <span className="inspect__pending">not yet in play</span>}
          </p>
        )}
      </div>
    </div>
  );
}
