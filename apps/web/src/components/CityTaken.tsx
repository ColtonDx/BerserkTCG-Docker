import { useEffect, useState, type JSX } from 'react';
import { CITY_CAPITAL, CITY_FACE } from './CardImage.js';

/**
 * A city changing hands, held up the way an opened card is.
 *
 * Taking a city is the largest thing that happens in a match — it is two of
 * the three you need to win (Rules.md §1) and it pays two cards on the spot
 * (§12, the city card's own effect). On the table it was a small card quietly
 * standing up in a row of five, and the two cards arriving in hand had nothing
 * to explain them.
 *
 * Shown to **both** players, because who holds what is public and the thing an
 * opponent most needs to know is that the board just moved. It takes no
 * pointer events, so play carries on underneath.
 */

/** Long enough to register, short enough to stay out of the way. */
const HOLD_MS = 2200;

export interface Taken {
  readonly key: number;
  readonly city: number;
  readonly name: string | null;
  readonly royalCapital: boolean;
  /** Whether the viewer is the one who took it. */
  readonly mine: boolean;
}

export function CityTaken({ taken, onDone }: { taken: Taken; onDone: () => void }): JSX.Element {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    setLeaving(false);
    const fade = window.setTimeout(() => setLeaving(true), HOLD_MS - 450);
    const done = window.setTimeout(onDone, HOLD_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(done);
    };
  }, [taken.key, onDone]);

  const classes = ['taken'];
  if (leaving) classes.push('taken--leaving');
  if (taken.royalCapital) classes.push('taken--capital');

  return (
    <div className={classes.join(' ')} aria-hidden="true">
      <div className="taken__card">
        <img
          className="taken__art"
          src={taken.royalCapital ? CITY_CAPITAL : CITY_FACE}
          alt=""
          draggable={false}
        />
      </div>

      {/* Low on the screen, where the game puts what it is telling you. */}
      <p className="taken__label">
        <span className="taken__title">City Occupied</span>
        <span className="taken__draw">
          {taken.mine ? 'You Draw 2 Cards' : 'Opponent Draws 2 Cards'}
        </span>
        <span className="taken__where">
          {taken.name ?? `Area ${taken.city + 1}`}
          {taken.royalCapital ? ' — the Royal Capital' : ''}
        </span>
      </p>
    </div>
  );
}
