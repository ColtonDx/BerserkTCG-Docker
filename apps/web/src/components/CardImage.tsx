import type { JSX } from 'react';

/** Card art is served by the API, not bundled into the client. */
export const CARD_ROOT = import.meta.env['VITE_SERVER_URL'] ?? '';

export const cardArt = (defId: string): string => `${CARD_ROOT}/cards/${defId}.jpg`;

/**
 * The one back every card shares — which is what makes a face-down card
 * hidden at all. Cut from the scans by `scripts/extract-cards.py --backs`,
 * which checks across all five volumes that they really are identical.
 *
 * City cards have their own back and are not in those scans; they still draw
 * as a hatch. See TODO.md 11.
 */
export const CARD_BACK = `${CARD_ROOT}/cards/back.jpg`;

/**
 * The City cards. Cut from their own scans by `scripts/extract-cities.py`,
 * because they are not in the volume PDFs the rest of the art comes from.
 *
 * `CITY_BACK` is the *area* back, which is a different design from the deck
 * card back above — and it is the only thing a face-down city may draw, or
 * the Royal Capital's position leaks off the table. Rules.md §5.
 */
export const CITY_FACE = `${CARD_ROOT}/cards/city.jpg`;
export const CITY_CAPITAL = `${CARD_ROOT}/cards/city-capital.jpg`;
export const CITY_BACK = `${CARD_ROOT}/cards/city-back.jpg`;

/** A card's printed face. Used at every size, from hand tile to inspector. */
export function CardImage({
  defId,
  className,
}: {
  readonly defId: string;
  readonly className?: string;
}): JSX.Element {
  return (
    <img
      className={className ?? 'card__art'}
      src={cardArt(defId)}
      alt={defId}
      loading="lazy"
      draggable={false}
    />
  );
}
