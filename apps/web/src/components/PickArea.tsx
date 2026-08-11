import type { PlayerView } from '@berserk/engine';
import { isCityHidden } from '@berserk/engine';
import { useEffect, type JSX } from 'react';

/**
 * "Which area?" — the second half of a play that moves somebody.
 *
 * Rules.md §13 has cards that name a character *and* an area: BK1-032 moves an
 * enemy "to an adjacent area", which is a real choice anywhere but the two ends
 * of the row. The character is chosen first with the targeting arrow, because
 * which areas are legal depends on where that character is standing — so by the
 * time this appears the engine has already worked out the shortlist and this
 * only has to ask.
 *
 * A bar rather than a board overlay: the areas on offer are few and adjacent,
 * naming them is unambiguous, and the board underneath stays readable while the
 * question is up — which matters, because the whole point of the play is where
 * somebody ends up relative to everyone else.
 */

interface Props {
  readonly view: PlayerView;
  /** The areas the engine offered, already filtered to the legal ones. */
  readonly areas: readonly number[];
  readonly onPick: (area: number) => void;
  readonly onCancel: () => void;
}

export function PickArea({ view, areas, onPick, onCancel }: Props): JSX.Element {
  // Escape backs out, the same as every other targeting step — a player should
  // never be trapped mid-play.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="targeting-bar" role="dialog" aria-modal="true" aria-label="Choose an area">
      <span>Move to which area?</span>
      {areas.map((index) => {
        const city = view.cities[index];
        // A face-down city has no name to show — that is the Royal Capital's
        // whole disguise (Rules.md §5) — so it is called by its position.
        const label = city && !isCityHidden(city) ? city.name : `Area ${index + 1}`;
        return (
          <button
            key={index}
            type="button"
            className="btn btn--primary"
            onClick={() => onPick(index)}
          >
            {label}
          </button>
        );
      })}
      <button type="button" className="btn" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
