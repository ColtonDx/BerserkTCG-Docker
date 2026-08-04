import { useCallback, useRef, useState, type DOMAttributes } from 'react';

/**
 * Dragging a card with a finger.
 *
 * The board's drag-to-set is HTML5 drag-and-drop, which touch devices do not
 * fire at all — so on a phone there was simply no way to put a card down. This
 * is the same gesture rebuilt on pointer events, which every input speaks.
 *
 * It is deliberately *only* for touch. Mouse dragging already works, and the
 * native implementation carries a drag image and the browser's own cursor
 * feedback; reimplementing that to no benefit would be a downgrade.
 *
 * The gesture has to share a card with two others — a tap opens the card, and
 * a long press peeks at it — so it does not commit until the finger has
 * actually travelled. Under that threshold nothing has happened yet and the
 * tap still lands.
 */

/** How far a finger must travel before this is a drag and not a tap. */
const SLOP_PX = 12;

export interface DragPayload {
  readonly card: string;
  readonly kind: 'set' | 'move';
  readonly cities: readonly number[];
}

export interface CardDrag {
  /** Props for a draggable card. Does nothing without a payload. */
  bind: (payload: DragPayload | undefined) => Pick<DOMAttributes<HTMLElement>, 'onPointerDown'>;
  /** Where the finger is, while dragging — for drawing the card under it. */
  readonly at: { readonly x: number; readonly y: number } | null;
}

interface Options {
  /** Called when a drag begins and ends, to light up the legal areas. */
  readonly onDrag: (payload: DragPayload | null) => void;
  /** Called when the finger lifts over an area that would accept the card. */
  readonly onDrop: (payload: DragPayload, city: number) => void;
  /** Cancels a press-and-hold, which the same finger may have started. */
  readonly onCancelPeek: () => void;
}

/** The area at this point, looking past anything floating over the board. */
function areaUnder(x: number, y: number): number | null {
  for (const element of document.elementsFromPoint(x, y)) {
    const area = element.closest<HTMLElement>('[data-city]');
    if (!area) continue;
    const index = Number(area.dataset['city']);
    if (Number.isInteger(index)) return index;
  }
  return null;
}

export function useCardDrag({ onDrag, onDrop, onCancelPeek }: Options): CardDrag {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const held = useRef<{
    payload: DragPayload;
    startX: number;
    startY: number;
    dragging: boolean;
    /** Where the finger last was. See the drop below for why. */
    lastX: number;
    lastY: number;
  } | null>(null);

  const finish = useCallback(() => {
    held.current = null;
    setAt(null);
    onDrag(null);
  }, [onDrag]);

  const bind = useCallback(
    (payload: DragPayload | undefined) => ({
      onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
        // Mouse keeps the native drag, which is better than this one.
        if (!payload || event.pointerType === 'mouse') return;
        held.current = {
          payload,
          startX: event.clientX,
          startY: event.clientY,
          lastX: event.clientX,
          lastY: event.clientY,
          dragging: false,
        };

        const move = (moved: PointerEvent): void => {
          const grip = held.current;
          if (!grip) return;
          const far =
            Math.abs(moved.clientX - grip.startX) > SLOP_PX ||
            Math.abs(moved.clientY - grip.startY) > SLOP_PX;
          if (!grip.dragging && far) {
            // Committed: this finger is dragging, not tapping or holding.
            grip.dragging = true;
            onCancelPeek();
            onDrag(grip.payload);
          }
          grip.lastX = moved.clientX;
          grip.lastY = moved.clientY;
          if (grip.dragging) setAt({ x: moved.clientX, y: moved.clientY });
        };

        const up = (lifted: PointerEvent): void => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', cancel);

          const grip = held.current;
          if (grip?.dragging) {
            // Where the finger *was*, not where the release says it is: a
            // touch that lifts reports the last contact point on some
            // browsers and (0, 0) on others, and a drop that silently landed
            // on the top-left corner of the page is a move that vanishes.
            const x = lifted.clientX || grip.lastX;
            const y = lifted.clientY || grip.lastY;
            // There is no hover on touch, so this is the only moment the
            // destination is known.
            //
            // *Every* element under the finger, not just the topmost: the
            // raised hand is a box that covers much of a short screen, and
            // asking only for the top one answered "the hand" for every drop
            // on a phone. Looking through it finds the area underneath.
            const city = areaUnder(x, y);
            if (city !== null && grip.payload.cities.includes(city)) {
              onDrop(grip.payload, city);
            }
          }
          finish();
        };

        const cancel = (): void => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', cancel);
          finish();
        };

        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', cancel);
      },
    }),
    [finish, onCancelPeek, onDrag, onDrop],
  );

  return { bind, at };
}
