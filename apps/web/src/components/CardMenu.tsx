import { useEffect, useRef, type JSX } from 'react';

/**
 * The right-click menu on a card.
 *
 * Only shows what the card can actually do right now, taken from the server's
 * legal actions — so the menu can never offer an illegal move, the same rule
 * the old wall of buttons followed.
 */

export interface CardMenuItem {
  readonly label: string;
  readonly onPick: () => void;
  /** Set for the entry that starts a targeting step, e.g. Set. */
  readonly hint?: string;
}

interface Props {
  readonly x: number;
  readonly y: number;
  readonly title: string;
  readonly items: readonly CardMenuItem[];
  readonly onClose: () => void;
}

export function CardMenu({ x, y, title, items, onClose }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    // Capture, so a click anywhere closes before it lands on something else.
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Keep the menu on screen when the card is near an edge.
  const style = {
    left: Math.min(x, window.innerWidth - 190),
    top: Math.min(y, window.innerHeight - 40 - items.length * 34),
  };

  return (
    <div className="cardmenu" style={style} ref={ref} role="menu">
      <p className="cardmenu__title">{title}</p>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className="cardmenu__item"
          onClick={() => {
            item.onPick();
            onClose();
          }}
        >
          {item.label}
          {item.hint && <span className="cardmenu__hint">{item.hint}</span>}
        </button>
      ))}
    </div>
  );
}
