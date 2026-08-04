import { useCallback, useEffect, useRef, type DOMAttributes } from 'react';

/**
 * Press and hold a card to look at it closely.
 *
 * Two seconds, so it never fires by accident on a click, a right-click or the
 * start of a drag — all three cancel it. The card comes up while the button is
 * down and goes away the moment it is released, which is what makes it feel
 * like leaning in rather than opening something.
 *
 * **It is entirely local.** Peeking submits no action and sends nothing over
 * the socket, so an opponent cannot tell that you are studying their board —
 * which is the whole point of being allowed to study a face-up card at all.
 */

const HOLD_MS = 2000;

export interface Peekable {
  /** Props to spread onto the card. */
  bind: (
    defId: string | null,
  ) => Pick<
    DOMAttributes<HTMLElement>,
    'onPointerDown' | 'onPointerUp' | 'onPointerLeave' | 'onPointerCancel'
  >;
  /** Cancel a press in progress — call from a drag start. */
  cancel: () => void;
  /**
   * True if the press just became a peek. A click fires on release, so a
   * component that acts on click has to ignore that one.
   */
  consumed: () => boolean;
}

export function usePeek(onPeek: (defId: string | null) => void): Peekable {
  const timer = useRef<number | null>(null);
  const fired = useRef(false);

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const release = useCallback(() => {
    cancel();
    if (fired.current) onPeek(null);
  }, [cancel, onPeek]);

  // A pointer released off the card — or off the window entirely — still ends
  // the press. Without this the card would stay up with nothing holding it.
  useEffect(() => {
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      window.removeEventListener('blur', release);
    };
  }, [release]);

  useEffect(() => cancel, [cancel]);

  return {
    cancel,
    consumed: () => {
      const was = fired.current;
      fired.current = false;
      return was;
    },
    bind: (defId) => ({
      onPointerDown: (event) => {
        // Left button only: right-click belongs to the card menu.
        if (!defId || event.button !== 0) return;
        fired.current = false;
        cancel();
        timer.current = window.setTimeout(() => {
          fired.current = true;
          onPeek(defId);
        }, HOLD_MS);
      },
      onPointerUp: release,
      onPointerLeave: release,
      onPointerCancel: release,
    }),
  };
}
