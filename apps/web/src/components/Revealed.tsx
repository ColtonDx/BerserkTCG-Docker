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
 *
 * One beat of the presentation queue: it lasts exactly as long as the beat
 * does (`ms`) and leaves with it. An open that fired an ability is shown once,
 * with the printed line — the same card held up twice in a row was reading
 * as two things happening.
 */

/** How long the exit takes, at the end of the beat. */
const LEAVE_MS = 400;

export interface Reveal {
  readonly key: number;
  readonly defId: string;
  /** False for a Normal effect, which resolves and leaves. Rules.md §3. */
  readonly stays: boolean;
  readonly mine: boolean;
  /** True when the card was opened; false when an ability on it went off. */
  readonly opened: boolean;
  /** Shown on its way into a hand — a search that says "reveal it". */
  readonly revealed: boolean;
  /**
   * The printed line, when an ability went off (Rules.md §13). Carried so the
   * player can see what just happened to their numbers.
   */
  readonly ability?: string;
  /** The ability resolved and found nothing to act on. */
  readonly fizzled: boolean;
  /** How long the beat holds the stage. */
  readonly ms: number;
}

export function Revealed({ reveal }: { reveal: Reveal }): JSX.Element {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    setLeaving(false);
    const fade = window.setTimeout(() => setLeaving(true), Math.max(0, reveal.ms - LEAVE_MS));
    return () => clearTimeout(fade);
  }, [reveal.key, reveal.ms]);

  const classes = ['reveal'];
  if (leaving) classes.push(reveal.stays ? 'reveal--settling' : 'reveal--spent');

  const who = reveal.revealed
    ? reveal.mine
      ? 'You reveal'
      : 'They reveal'
    : reveal.opened
      ? reveal.mine
        ? 'You open'
        : 'They open'
      : reveal.mine
        ? 'Your ability'
        : 'Their ability';

  return (
    <div className={classes.join(' ')} aria-hidden="true">
      <div className="reveal__card">
        <CardImage defId={reveal.defId} className="reveal__art" />
      </div>
      <p className="reveal__label">
        <span className="reveal__who">{who}</span>
        <span className="reveal__name">{nameOf(reveal.defId)}</span>
        {/* The printed line, so a change to the numbers is explained by the
         * card that caused it rather than appearing out of nowhere. */}
        {reveal.ability !== undefined && <span className="reveal__ability">{reveal.ability}</span>}
        {/* Rules.md §13 resolves what it can; saying so is what keeps a card
         * that changed nothing from looking like a card that does not work. */}
        {reveal.fizzled && <span className="reveal__fizzle">nothing for it to affect</span>}
        {/* A Normal effect never reaches the table, so say where it went. */}
        {reveal.revealed && <span className="reveal__fate">to hand</span>}
        {reveal.opened && !reveal.stays && (
          <span className="reveal__fate">resolves, then to the graveyard</span>
        )}
      </p>
    </div>
  );
}
