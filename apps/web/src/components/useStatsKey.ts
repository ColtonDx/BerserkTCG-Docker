import { useEffect, useState } from 'react';

/**
 * True while left Control is held.
 *
 * Counts, zone sizes and occupation are reference material, not something to
 * read every turn, so the table stays clean and they come up on demand. Each
 * number appears over the thing it counts rather than in a status bar, which
 * is what makes it worth hiding — you look at the pile, not at a legend.
 *
 * The release cases matter more than the press: a key held while the window
 * loses focus never sends its `keyup`, so without the blur and visibility
 * handlers the overlay would stick on until the next press.
 */

/** `KeyboardEvent.DOM_KEY_LOCATION_LEFT`. Some layouts report 0 instead. */
const LEFT = 1;
const STANDARD = 0;

export function useStatsKey(): boolean {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (event.key !== 'Control') return;
      if (event.location !== LEFT && event.location !== STANDARD) return;
      setHeld(true);
    };
    const up = (event: KeyboardEvent): void => {
      if (event.key === 'Control') setHeld(false);
    };
    const clear = (): void => setHeld(false);

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', clear);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', clear);
    };
  }, []);

  return held;
}
