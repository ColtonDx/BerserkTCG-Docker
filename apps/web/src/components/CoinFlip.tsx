import { useEffect, useState, type JSX } from 'react';
import { playCoinFlip } from '../net/sound.js';

/**
 * The toss for first player, held up before the opening hands.
 *
 * Rules.md §9.2 determines the first player randomly, and the engine already
 * has: the seat order in `GameState.seats` is a seeded shuffle, and index 0
 * goes first. Nothing here decides anything — the result arrived with the
 * deal, and this only shows it. That matters, because a coin that decided
 * something in the browser would be a rule living in the client.
 *
 * It earns the screen because of what it settles. Going first skips a draw
 * (§10 ②) and reaches the first Open step ahead of the opponent, and until
 * this existed the only sign of who had won it was whose name the turn banner
 * happened to show a moment later.
 *
 * The coin spins for a fixed time and lands on a face: heads for the viewer,
 * tails for the opponent. Which face is which is decided by the result, not
 * the other way round — the animation is a reveal, not a draw.
 */

/** How long the coin spins before it settles. */
const SPIN_MS = 1700;
/** How long the result holds once it has landed, before the panel fades. */
const HOLD_MS = 2400;
/** The fade itself, matching the CSS. */
const FADE_MS = 500;

export interface Toss {
  /** Changes per match, so a new deal re-runs the animation. */
  readonly key: string;
  /** Whether the viewer is the one going first. */
  readonly mine: boolean;
  /** Who goes first, by display name. */
  readonly who: string;
}

/**
 * Whether the viewer has asked for less motion.
 *
 * The spin is the entire reason this waits before showing the answer, so
 * somebody who has turned animation off should not be made to wait for one
 * that is not playing — the CSS suppresses the spin, and this suppresses the
 * pause that went with it.
 */
const reducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function CoinFlip({ toss, onDone }: { toss: Toss; onDone: () => void }): JSX.Element {
  const [landed, setLanded] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const spin = reducedMotion() ? 0 : SPIN_MS;
    setLanded(spin === 0);
    setLeaving(false);
    // Scored to the same spin, so the landing ring arrives with the coin
    // settling rather than over the top of it.
    playCoinFlip(spin);
    const settle = window.setTimeout(() => setLanded(true), spin);
    const fade = window.setTimeout(() => setLeaving(true), spin + HOLD_MS - FADE_MS);
    const done = window.setTimeout(onDone, spin + HOLD_MS);
    return () => {
      clearTimeout(settle);
      clearTimeout(fade);
      clearTimeout(done);
    };
  }, [toss.key, onDone]);

  const classes = ['toss'];
  if (leaving) classes.push('toss--leaving');

  return (
    // Not a dialog: there is nothing to answer and nothing to dismiss. It
    // takes no pointer events, so the deal carries on underneath it.
    <div className={classes.join(' ')} aria-hidden="true">
      <div className="toss__panel">
        <p className="toss__title">Deciding who goes first</p>

        <div className={landed ? 'toss__coin toss__coin--landed' : 'toss__coin toss__coin--spin'}>
          {/* Both faces are always in the DOM and the coin is rotated in CSS,
              so the landing is a real turn rather than a swap of images. */}
          <span className="toss__face toss__face--heads">{toss.mine ? 'YOU' : 'THEM'}</span>
          <span className="toss__face toss__face--tails">{toss.mine ? 'THEM' : 'YOU'}</span>
        </div>

        {/* Held back until the coin lands, so the answer does not arrive
            before the question has finished being asked. */}
        <p className={landed ? 'toss__result toss__result--in' : 'toss__result'}>
          <span className="toss__who">{toss.mine ? 'You go first' : `${toss.who} goes first`}</span>
          <span className="toss__note">
            {toss.mine ? 'You skip your first draw' : 'You draw on your first turn'}
          </span>
        </p>
      </div>
    </div>
  );
}

/**
 * A screen-reader announcement of the same thing.
 *
 * The panel above is `aria-hidden` because it is an animation, and an
 * animation read out mid-spin says the wrong thing. This is the result on its
 * own, in a live region, once.
 */
export function TossAnnouncement({ toss }: { toss: Toss }): JSX.Element {
  return (
    <p className="visually-hidden" role="status">
      {toss.mine ? 'You go first.' : `${toss.who} goes first.`}
    </p>
  );
}
