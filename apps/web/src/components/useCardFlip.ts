import { useLayoutEffect, useRef } from 'react';

/**
 * Cards slide between zones instead of teleporting.
 *
 * FLIP: after every render, compare where each card is now against where it
 * was, then start it at the old place and let it transition to the new one.
 * Cards are found by `data-card-id`, so this survives a card moving from the
 * hand into a city — different components, different DOM nodes, same card.
 *
 * Only *zone changes* animate. A card shifting because the hand fanned open,
 * or because the window resized, is already being handled by CSS, and running
 * both at once makes the motion fight itself.
 *
 * A card appearing in a hand for the first time is the exception: it was in a
 * deck, and a deck is never drawn card by card, so it has no previous
 * position to move from. It is given one — the deck it came off — which is
 * what makes a draw look like a draw rather than a card blinking into a fan.
 *
 * The translation goes through `--flip-x/--flip-y` rather than `transform`
 * directly, so it composes with the fan rotation and the locked tilt instead
 * of overwriting them.
 */

const DURATION_MS = 620;
const EASE = 'cubic-bezier(0.22, 0.68, 0.28, 1)';
/** Ignore sub-pixel drift and rounding. */
const THRESHOLD_PX = 2;

interface Snapshot {
  readonly zone: string;
  readonly x: number;
  readonly y: number;
}

/**
 * Where a card that has just appeared came from, when that is knowable.
 *
 * Only a hand answers: a card entering one was drawn, and the deck it was
 * drawn from is on screen. Anything else appearing from nowhere is left
 * alone rather than given an invented origin.
 */
function deckOrigin(node: HTMLElement, snap: Snapshot): Snapshot | null {
  if (snap.zone !== 'hand') return null;
  const side = node.closest('.ohand') ? 'theirs' : 'mine';
  const deck = document.querySelector<HTMLElement>(`[data-deck="${side}"]`);
  if (!deck) return null;
  const rect = deck.getBoundingClientRect();
  return { zone: 'deck', x: rect.left, y: rect.top };
}

function snapshot(): Map<string, { node: HTMLElement; snap: Snapshot }> {
  const found = new Map<string, { node: HTMLElement; snap: Snapshot }>();
  for (const node of document.querySelectorAll<HTMLElement>('[data-card-id]')) {
    const id = node.dataset['cardId'];
    if (!id) continue;
    const rect = node.getBoundingClientRect();
    found.set(id, {
      node,
      snap: { zone: node.dataset['cardZone'] ?? '', x: rect.left, y: rect.top },
    });
  }
  return found;
}

/**
 * Returns a function that re-measures without animating — call it when cards
 * settle somewhere new for a reason that is not a game action, so the next
 * real move starts from where the card actually is.
 */
export function useCardFlip(): () => void {
  const previous = useRef<Map<string, Snapshot>>(new Map());

  const measure = (animate: boolean): void => {
    const current = snapshot();

    if (animate) {
      for (const [id, { node, snap }] of current) {
        const before = previous.current.get(id) ?? deckOrigin(node, snap);
        if (!before || before.zone === snap.zone) continue;

        const dx = before.x - snap.x;
        const dy = before.y - snap.y;
        if (Math.abs(dx) < THRESHOLD_PX && Math.abs(dy) < THRESHOLD_PX) continue;

        // Put it back where it was, with no transition to animate the jump.
        node.style.transition = 'none';
        node.style.setProperty('--flip-x', `${dx}px`);
        node.style.setProperty('--flip-y', `${dy}px`);
        node.classList.add('card--flying');

        requestAnimationFrame(() => {
          node.style.transition = `transform ${DURATION_MS}ms ${EASE}`;
          node.style.setProperty('--flip-x', '0px');
          node.style.setProperty('--flip-y', '0px');
          window.setTimeout(() => {
            node.style.transition = '';
            node.style.removeProperty('--flip-x');
            node.style.removeProperty('--flip-y');
            node.classList.remove('card--flying');
          }, DURATION_MS);
        });
      }
    }

    previous.current = new Map([...current].map(([id, { snap }]) => [id, snap]));
  };

  // No dependency list: every commit is a chance for a card to have moved.
  useLayoutEffect(() => {
    measure(true);
  });

  return () => measure(false);
}
