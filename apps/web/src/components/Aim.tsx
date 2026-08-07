import { useEffect, useState, type JSX } from 'react';
import { nameOf, textOf } from '../state/useCardNames.js';

/**
 * Pointing a card at somebody. Rules.md §13.
 *
 * The board stays where it is and the choice is made on it: the legal targets
 * light up, everything else dims, and an arrow runs from the card doing the
 * pointing to wherever the pointer is. Choosing a victim out of a row of
 * thumbnails in a dialog told you their name and nothing about where they were
 * standing, which is the half that matters.
 *
 * This draws the arrow and the heading; the highlighting lives on the board,
 * and the click that lands the choice belongs to the card itself.
 *
 * Both ends are measured from the DOM by `data-card-id`, the same handle the
 * card animator uses, because a card's position is a layout fact — there is
 * nowhere in the view to read it from.
 */

interface Props {
  /** The card being pointed, which is where the arrow starts. */
  readonly source: string;
  /** Its printed id, for the heading. */
  readonly defId: string | null;
  /** Everyone it may be pointed at, so the arrow has somewhere to rest. */
  readonly options: readonly string[];
  /** Highlighted right now, so the arrow can snap to it. */
  readonly hovered: string | null;
  readonly onCancel: () => void;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

const centreOf = (cardId: string): Point | null => {
  const node = document.querySelector<HTMLElement>(`[data-card-id="${cardId}"]`);
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};

export function Aim({ source, defId, options, hovered, onCancel }: Props): JSX.Element {
  const [from, setFrom] = useState<Point | null>(() => centreOf(source));
  // Rests on a real candidate until the pointer moves, so the arrow is there
  // the instant the step begins — a touchscreen sends no pointer move at all
  // before the tap that answers, and an arrow that only appeared on mouse
  // movement would simply never be seen on one.
  const [to, setTo] = useState<Point | null>(
    () => (options[0] ? centreOf(options[0]) : null) ?? null,
  );

  // The source can move under the arrow — the hand slides, the board reflows —
  // so it is re-measured on the same events that would move it rather than
  // read once and trusted.
  useEffect(() => {
    const measure = (): void => setFrom(centreOf(source));
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [source]);

  // Follows the pointer, and snaps to a target once one is under it: the snap
  // is the feedback that says "let go here and this is the one".
  useEffect(() => {
    const move = (event: PointerEvent): void => setTo({ x: event.clientX, y: event.clientY });
    window.addEventListener('pointermove', move);
    return () => window.removeEventListener('pointermove', move);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const snapped = hovered ? centreOf(hovered) : null;
  const tip = snapped ?? to;
  const text = defId ? textOf(defId) : null;

  return (
    <>
      <div className="aim-bar" role="status">
        <span className="aim-bar__title">
          Select a target for {defId ? nameOf(defId) : 'this card'}
        </span>
        {text && <span className="aim-bar__text">{text}</span>}
        <button type="button" className="btn aim-bar__cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>

      {from && tip && <Arrow from={from} to={tip} locked={snapped !== null} />}
    </>
  );
}

/**
 * The arrow itself.
 *
 * Drawn as one quadratic curve bowed away from the straight line, because a
 * straight arrow across a board of straight edges reads as a UI border rather
 * than as a gesture. The glow is a second, fatter copy of the same path
 * underneath — cheaper than a filter, and it survives being animated.
 */
function Arrow({ from, to, locked }: { from: Point; to: Point; locked: boolean }): JSX.Element {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const raw = Math.hypot(dx, dy);

  // A card can be its own target — "target 1 character in this area" means
  // itself when it is the only one standing there (Rules.md §13). The run is
  // then zero length, so the direction is taken as straight up and the bow
  // given a floor: the arrow leaves the card and comes back to it, which is
  // what pointing at yourself looks like.
  const length = raw || 1;
  const ux = raw === 0 ? 0 : dx / length;
  const uy = raw === 0 ? -1 : dy / length;

  // Bow perpendicular to the run, a fixed fraction of it, capped so a long
  // reach across the board does not turn into a semicircle.
  const bow = Math.max(Math.min(length * 0.18, 90), raw < 40 ? 54 : 0);
  const midX = (from.x + to.x) / 2 - uy * bow;
  const midY = (from.y + to.y) / 2 + ux * bow;
  const path = `M ${from.x} ${from.y} Q ${midX} ${midY} ${to.x} ${to.y}`;

  // The head points along the tangent at the tip, which for a quadratic is the
  // line from the control point to the end — not the chord, which would leave
  // it visibly askew on a bowed arrow.
  const angle = (Math.atan2(to.y - midY, to.x - midX) * 180) / Math.PI;

  return (
    <svg className={locked ? 'aim-arrow aim-arrow--locked' : 'aim-arrow'} aria-hidden="true">
      <path className="aim-arrow__glow" d={path} />
      <path className="aim-arrow__line" d={path} />
      <g transform={`translate(${to.x} ${to.y}) rotate(${angle})`}>
        <path className="aim-arrow__head" d="M 0 0 L -22 -11 L -16 0 L -22 11 Z" />
      </g>
    </svg>
  );
}
