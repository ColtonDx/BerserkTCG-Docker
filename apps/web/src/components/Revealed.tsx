import { useEffect, useState, type JSX } from 'react';
import { CardImage } from './CardImage.js';
import { nameOf } from '../state/useCardNames.js';

/**
 * A card being opened, held up in the middle of the screen.
 *
 * Opening is the moment a card stops being a face-down rectangle and starts
 * mattering, and on the table it happens at thumbnail size in a corner of the
 * board — easy to miss entirely, and impossible to read. So it comes forward,
 * big enough to read, for long enough to read it.
 *
 * Shown to **both** players: an open is public, and the thing an opponent most
 * needs to know is what just came down. It takes no pointer events, so play
 * carries on underneath it.
 */

/** Long enough to read a card's text; short enough not to be in the way. */
const HOLD_MS = 1700;

export interface Reveal {
  readonly key: number;
  readonly defId: string;
  /** False for a Normal effect, which resolves and leaves. Rules.md §3. */
  readonly stays: boolean;
  readonly mine: boolean;
  /**
   * Set when the card is coming forward because its printed ability went off
   * rather than because it was opened (Rules.md §13). Carries the line, so
   * the player can see what just happened to their numbers.
   */
  readonly ability?: string;
}

export function Revealed({ reveal, onDone }: { reveal: Reveal; onDone: () => void }): JSX.Element {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    setLeaving(false);
    const fade = window.setTimeout(() => setLeaving(true), HOLD_MS - 400);
    const done = window.setTimeout(onDone, HOLD_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(done);
    };
  }, [reveal.key, onDone]);

  const classes = ['reveal'];
  if (leaving) classes.push(reveal.stays ? 'reveal--settling' : 'reveal--spent');

  return (
    <div className={classes.join(' ')} aria-hidden="true">
      <div className="reveal__card">
        <CardImage defId={reveal.defId} className="reveal__art" />
      </div>
      <p className="reveal__label">
        <span className="reveal__who">
          {reveal.ability
            ? reveal.mine
              ? 'Your ability'
              : 'Their ability'
            : reveal.mine
              ? 'You open'
              : 'They open'}
        </span>
        <span className="reveal__name">{nameOf(reveal.defId)}</span>
        {/* The printed line, so a change to the numbers is explained by the
         * card that caused it rather than appearing out of nowhere. */}
        {reveal.ability !== undefined && <span className="reveal__ability">{reveal.ability}</span>}
        {/* A Normal effect never reaches the table, so say where it went. */}
        {reveal.ability === undefined && !reveal.stays && (
          <span className="reveal__fate">resolves, then to the graveyard</span>
        )}
      </p>
    </div>
  );
}
