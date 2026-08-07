import { useEffect, useState, type JSX } from 'react';

/**
 * Who is holding whom up. Rules.md §13.
 *
 * A continuous ability is not written down anywhere on the table: Griffith
 * standing in an area simply makes the Band around him bigger, and the only
 * sign of it is a number that does not match the printed one. Hovering a
 * character draws the connection — a line from every card lifting it, and a
 * line out to everything it is lifting — so "why is this +1/+1" is one
 * movement of the pointer rather than a trip through the inspector.
 *
 * The server sends the pairing (`VisibleCard.boostedBy`) because the client
 * cannot work it out: which cards an ability reaches is engine data, and the
 * card database holds only the printed line.
 *
 * Both ends are measured from the DOM by `data-card-id`, the handle the card
 * animator and the targeting arrow already use — where a card is sitting is a
 * layout fact and there is nowhere in the view to read it from.
 */

export interface BoostLink {
  /** The card whose ability is doing the lifting. */
  readonly from: string;
  /** The card being lifted. */
  readonly to: string;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Measured {
  readonly from: Point;
  readonly to: Point;
}

const centreOf = (cardId: string): Point | null => {
  const node = document.querySelector<HTMLElement>(`[data-card-id="${cardId}"]`);
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};

const measure = (links: readonly BoostLink[]): Measured[] => {
  const out: Measured[] = [];
  for (const link of links) {
    const from = centreOf(link.from);
    const to = centreOf(link.to);
    if (from && to) out.push({ from, to });
  }
  return out;
};

/** A stable key for the set of links, so the effect re-measures when it changes. */
const keyOf = (links: readonly BoostLink[]): string =>
  links.map((link) => `${link.from}>${link.to}`).join('|');

export function BoostLinks({
  links,
  version,
}: {
  readonly links: readonly BoostLink[];
  /** The view this was drawn for, so a card that has moved is re-measured. */
  readonly version: number;
}): JSX.Element | null {
  const [lines, setLines] = useState<readonly Measured[]>(() => measure(links));
  const key = keyOf(links);

  // Re-measured on the events that would move a card under the line: the hand
  // sliding up, the board reflowing, the window changing shape. Read once and
  // trusted, a line would keep pointing at where a card used to be.
  useEffect(() => {
    const remeasure = (): void => setLines(measure(links));
    remeasure();
    window.addEventListener('resize', remeasure);
    window.addEventListener('scroll', remeasure, true);
    return () => {
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('scroll', remeasure, true);
    };
    // Keyed by the contents rather than by the array, which is rebuilt on every
    // render — depending on its identity would re-run this forever.
  }, [key, version]);

  if (lines.length === 0) return null;

  return (
    <svg className="boost-links" aria-hidden="true">
      {lines.map((line, index) => (
        <Link key={index} from={line.from} to={line.to} />
      ))}
    </svg>
  );
}

/**
 * One connection.
 *
 * Bowed like the targeting arrow, for the same reason — a straight line across
 * a board of straight edges reads as a border — but quieter: no head, a bead at
 * the source end, and a dash that runs along it towards the card being lifted,
 * so which end is giving and which is receiving is visible without a legend.
 */
function Link({ from, to }: { from: Point; to: Point }): JSX.Element {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const raw = Math.hypot(dx, dy);
  const length = raw || 1;
  const ux = raw === 0 ? 0 : dx / length;
  const uy = raw === 0 ? -1 : dy / length;

  const bow = Math.min(length * 0.16, 70);
  const midX = (from.x + to.x) / 2 - uy * bow;
  const midY = (from.y + to.y) / 2 + ux * bow;
  const path = `M ${from.x} ${from.y} Q ${midX} ${midY} ${to.x} ${to.y}`;

  return (
    <g>
      <path className="boost-links__glow" d={path} />
      <path className="boost-links__line" d={path} />
      <path className="boost-links__flow" d={path} />
      <circle className="boost-links__bead" cx={from.x} cy={from.y} r={5} />
    </g>
  );
}
