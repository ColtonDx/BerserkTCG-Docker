import type { GameAction, PlayerView } from '@berserk/engine';
import { useState, type JSX } from 'react';
import { CardImage } from './CardImage.js';
import { usePeek } from './usePeek.js';
import { nameOf } from '../state/useCardNames.js';

/**
 * The hand, front and centre, for the steps that are only about the hand:
 * settling the opening hand, putting cards on the bottom after a mulligan,
 * and discarding to the hand limit.
 *
 * The battlefield is dimmed behind it rather than hidden — nothing is
 * happening out there during these steps, and keeping it visible preserves
 * the sense of place.
 *
 * Which step this is comes from the legal actions the server sent, not from
 * anything worked out here, so it cannot drift from what the engine allows.
 */

export type HandStep =
  | { readonly kind: 'mulligan'; readonly costOfKeeping: number }
  | { readonly kind: 'bottom'; readonly owed: number }
  | { readonly kind: 'discard'; readonly over: number };

/** Which hand step, if any, the player owes right now. */
export function handStep(view: PlayerView): HandStep | null {
  const has = (type: GameAction['type']): boolean =>
    view.legalActions.some((action) => action.type === type);

  if (view.pendingBottom > 0) return { kind: 'bottom', owed: view.pendingBottom };
  if (has('KEEP_HAND')) {
    // Bottoming is paid after keeping, so say up front what keeping will cost.
    const hand = view.zoneOrder[`${view.viewer}:hand`]?.length ?? 0;
    return { kind: 'mulligan', costOfKeeping: Math.max(0, hand - view.handTarget) };
  }

  if (has('DISCARD_CARD')) {
    const hand = view.zoneOrder[`${view.viewer}:hand`]?.length ?? 0;
    // Rules.md §10 ⑤ — the turn cannot pass while over seven.
    return { kind: 'discard', over: Math.max(1, hand - 7) };
  }
  return null;
}

interface Props {
  readonly view: PlayerView;
  readonly step: HandStep;
  readonly onAction: (action: GameAction) => void;
  readonly onInspect: (defId: string) => void;
  readonly onPeek: (defId: string | null) => void;
}

export function HandFocus({ view, step, onAction, onInspect, onPeek }: Props): JSX.Element {
  const peek = usePeek(onPeek);
  // Deciding on a hand means reading it. During the mulligan there is nothing
  // to click a card *for*, so a click is a look: it zooms, and clicking away
  // puts it back.
  const [zoomed, setZoomed] = useState<string | null>(null);
  const hand = (view.zoneOrder[`${view.viewer}:hand`] ?? [])
    .map((id) => view.cards[id])
    .filter((card): card is NonNullable<typeof card> => card !== undefined);

  // A card is clickable only when the current step actually acts on cards.
  const picking = step.kind !== 'mulligan';
  const actionFor = (instanceId: string): GameAction | null => {
    if (step.kind === 'bottom') return { type: 'BOTTOM_CARD', card: instanceId as never };
    if (step.kind === 'discard') return { type: 'DISCARD_CARD', card: instanceId as never };
    return null;
  };

  const legal = (instanceId: string): boolean => {
    const wanted = actionFor(instanceId);
    if (!wanted) return false;
    return view.legalActions.some(
      (action) => action.type === wanted.type && 'card' in action && action.card === instanceId,
    );
  };

  return (
    <>
      {/* Outside `.focus`, not inside it: `.focus` sets a z-index and so opens
          a stacking context, which would trap this underneath the header
          however high its own z-index went. */}
      {zoomed && (
        <button
          type="button"
          className="focus__zoom"
          aria-label="Close"
          onClick={() => setZoomed(null)}
        >
          <CardImage defId={zoomed} className="focus__zoomart" />
        </button>
      )}
      <div className="focus">
        <div className="focus__panel">
          <h2 className="focus__title">{title(step)}</h2>
          <p className="focus__hint">{hint(step)}</p>

          <div className="focus__hand">
            {hand.map((card) => {
              const defId = 'defId' in card ? card.defId : null;
              const clickable = picking && legal(card.instanceId);
              return (
                <button
                  key={card.instanceId}
                  type="button"
                  className={clickable ? 'focus__card focus__card--pick' : 'focus__card'}
                  disabled={picking && !clickable}
                  onClick={() => {
                    // A hold ends in a click; that one is not a choice.
                    if (peek.consumed()) return;
                    const action = actionFor(card.instanceId);
                    if (clickable && action) {
                      onAction(action);
                      return;
                    }
                    // Nothing to do with it but look at it.
                    if (defId) setZoomed((current) => (current === defId ? null : defId));
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (defId) onInspect(defId);
                  }}
                  title={defId ? nameOf(defId) : 'Card'}
                  {...peek.bind(defId)}
                >
                  {defId ? <CardImage defId={defId} className="focus__art" /> : null}
                </button>
              );
            })}
          </div>

          {step.kind === 'mulligan' && (
            <div className="focus__actions">
              <button
                type="button"
                className="btn"
                disabled={!view.legalActions.some((a) => a.type === 'MULLIGAN')}
                onClick={() => onAction({ type: 'MULLIGAN' })}
              >
                Mulligan
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => onAction({ type: 'KEEP_HAND' })}
              >
                Keep
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function title(step: HandStep): string {
  if (step.kind === 'mulligan') return 'Your opening hand';
  if (step.kind === 'bottom') return 'Put cards on the bottom';
  return 'Discard to seven';
}

function hint(step: HandStep): string {
  if (step.kind === 'mulligan') {
    if (step.costOfKeeping === 0) return 'Keep this hand, or shuffle it back and draw again.';
    const cards = step.costOfKeeping === 1 ? 'one card' : `${step.costOfKeeping} cards`;
    return `Keeping puts ${cards} on the bottom. Mulligan again to cost one more.`;
  }
  if (step.kind === 'bottom') {
    return step.owed === 1
      ? 'Click a card to put it on the bottom of your deck.'
      : `Click ${step.owed} cards to put on the bottom of your deck.`;
  }
  return step.over === 1 ? 'Click a card to discard it.' : `Click ${step.over} cards to discard.`;
}
