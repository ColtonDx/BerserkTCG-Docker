import { flushSync } from 'react-dom';
import { playPageTurn } from './sound.js';

/**
 * Turns the current screen away like a page, revealing the next one behind it.
 *
 * The thing that turns is the **screen itself**, not a sheet drawn over it.
 * That is what the View Transitions API is for: the browser snapshots the
 * outgoing document, we swap in the new screen underneath, and then animate
 * the snapshot. An overlay pretending to be paper can only ever look like a
 * rectangle appearing in front of the page it is supposed to be.
 *
 * The turn itself is in `styles.css` on `::view-transition-old(root)`.
 *
 * Where the API is missing, or the reader prefers reduced motion, the screen
 * simply changes. The sound still plays — it is the feedback for the click,
 * not decoration on the animation.
 */

export function turnPage(go: () => void): void {
  playPageTurn();

  // Typed in the DOM lib, but not implemented everywhere — Firefox and older
  // Safari fall through to the plain swap below.
  const start = document.startViewTransition?.bind(document);
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (still || !start) {
    go();
    return;
  }

  start(() => {
    // The snapshot is already taken; the DOM has to be at its new state
    // before this callback returns, so the swap cannot wait for React's
    // usual batching.
    flushSync(go);
  });
}
