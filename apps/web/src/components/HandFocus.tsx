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
  | { readonly kind: 'discard'; readonly over: number }
  /**
   * A card's printed line has stopped to ask which cards. Rules.md §13.
   *
   * Carries the line itself rather than a paraphrase, so the prompt says what
   * the card says. `from` is the zone being picked out of: a pitch reads the
   * hand, a search reads the cards the server revealed out of the deck.
   */
  | {
      readonly kind: 'choose';
      readonly owed: number;
      readonly text: string;
      readonly from: 'hand' | 'deck' | 'field' | 'deckTop';
      /** What happens to a chosen card, which is what the prompt has to say. */
      readonly action:
        | 'discard'
        | 'setAndOpen'
        | 'toHand'
        | 'toTrash'
        | 'toCity'
        | 'toCityOpen'
        | 'destroy'
        | 'reorder'
        | 'toCityAnywhere'
        | 'moveHere'
        | 'pay'
        | 'lock'
        | 'hit'
        | 'scatter';
      /** The player may stop short of the count. Rules.md §13 — "up to". */
      readonly upTo: boolean;
    }
  /** A card asking yes or no — "you may …". Rules.md §13. */
  | { readonly kind: 'decide'; readonly text: string };

/** Which hand step, if any, the player owes right now. */
export function handStep(view: PlayerView): HandStep | null {
  const has = (type: GameAction['type']): boolean =>
    view.legalActions.some((action) => action.type === type);

  // First, because it outranks everything: until it is answered nothing else
  // in the game is legal at all (Rules.md §13).
  if (view.pending && view.pending.waitingOn === view.viewer) {
    const kind = view.pending.kind;
    if (kind.zone === 'decision') return { kind: 'decide', text: view.pending.text };
    return {
      kind: 'choose',
      owed: view.pending.count,
      text: view.pending.text,
      from: kind.zone,
      action: kind.action,
      upTo: view.pending.upTo,
    };
  }

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
  // The card waiting on an area, for a choice that asks for both (BK1-155).
  const [held, setHeld] = useState<string | null>(null);
  // Which cards are laid out. Every step but one is about the hand; a deck
  // search is about the cards the *server* revealed out of the deck, which is
  // exactly the set it offered a `CHOOSE_CARD` for. Reading them off the legal
  // actions rather than off the deck zone is deliberate: the client is never
  // sent the rest of the deck, so this cannot show a card it should not.
  // A deck search and a choice made on the field are laid out the same way:
  // from the cards the server actually offered, never from a zone the client
  // holds. For the field that also keeps a face-down Set Card face-down for
  // everyone but the player being asked to give one up (BK1-100).
  // A deck search, a field choice, and a deck-top reorder are all laid out
  // from the cards the server offered rather than from a zone the client
  // holds — that is what keeps the rest of the deck out of sight.
  const searching =
    step.kind === 'choose' &&
    (step.from === 'deck' || step.from === 'field' || step.from === 'deckTop');
  const shown =
    step.kind === 'decide'
      ? []
      : searching
        ? view.legalActions
            .filter((action) => action.type === 'CHOOSE_CARD')
            .map(
              (action) => view.cards[(action as Extract<GameAction, { type: 'CHOOSE_CARD' }>).card],
            )
            .filter((card): card is NonNullable<typeof card> => card !== undefined)
        : (view.zoneOrder[`${view.viewer}:hand`] ?? [])
            .map((id) => view.cards[id])
            .filter((card): card is NonNullable<typeof card> => card !== undefined);
  // "That will do": an up-to choice may be ended early. Rules.md §13.
  const canStop = view.legalActions.some((action) => action.type === 'ANSWER' && !action.accept);

  // A card is clickable only when the current step actually acts on cards.
  const picking = step.kind !== 'mulligan' && step.kind !== 'decide';
  // "Set them anywhere" wants a card *and* an area (BK1-155), so the card is
  // held here while the areas it may go to are offered.
  const placing = step.kind === 'choose' && step.action === 'toCityAnywhere';
  const destinations = (instanceId: string): number[] =>
    view.legalActions
      .filter(
        (action) =>
          action.type === 'CHOOSE_CARD' && action.card === instanceId && action.city !== undefined,
      )
      .map((action) => (action as Extract<GameAction, { type: 'CHOOSE_CARD' }>).city as number);

  const actionFor = (instanceId: string): GameAction | null => {
    if (step.kind === 'bottom') return { type: 'BOTTOM_CARD', card: instanceId as never };
    if (step.kind === 'discard') return { type: 'DISCARD_CARD', card: instanceId as never };
    if (step.kind === 'choose') {
      // Held back until an area is picked; `held` below sends it.
      if (placing) return null;
      return { type: 'CHOOSE_CARD', card: instanceId as never };
    }
    return null;
  };

  const legal = (instanceId: string): boolean => {
    if (placing) return destinations(instanceId).length > 0;
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
            {shown.map((card) => {
              const defId = 'defId' in card ? card.defId : null;
              const clickable = picking && legal(card.instanceId);
              return (
                // The magnifier is a sibling of the card, not a child of it:
                // a button may not contain another interactive element, and
                // nesting one inside made the whole tile ambiguous to click.
                <div key={card.instanceId} className="focus__slot">
                  <button
                    type="button"
                    className={clickable ? 'focus__card focus__card--pick' : 'focus__card'}
                    disabled={picking && !clickable}
                    onClick={() => {
                      // A hold ends in a click; that one is not a choice.
                      if (peek.consumed()) return;
                      if (placing && clickable) {
                        // Pick the card now, the area next (BK1-155).
                        setHeld((current) =>
                          current === card.instanceId ? null : card.instanceId,
                        );
                        return;
                      }
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

                  {/* A look, on every step.
                   *
                   * Bottoming and discarding cannot be taken back, and until
                   * this was here the only ways to read a card first were a
                   * right click and a press-and-hold — one of which a
                   * touchscreen does not have, and neither of which anybody
                   * discovers. A card you are about to throw away for good is
                   * exactly the one worth being sure about, and deciding on an
                   * opening hand means reading it too. */}
                  {defId && (
                    <button
                      type="button"
                      className="focus__look"
                      aria-label={`Inspect ${nameOf(defId)}`}
                      title={`Inspect ${nameOf(defId)}`}
                      onClick={() => {
                        peek.cancel();
                        onInspect(defId);
                      }}
                    >
                      🔍
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {placing && held && (
            <div className="focus__actions">
              {destinations(held).map((city) => (
                <button
                  key={city}
                  type="button"
                  className="focus__button"
                  onClick={() => {
                    onAction({ type: 'CHOOSE_CARD', card: held as never, city });
                    setHeld(null);
                  }}
                >
                  {`Area ${city + 1}`}
                </button>
              ))}
            </div>
          )}

          {step.kind === 'decide' && (
            <div className="focus__actions">
              <button
                type="button"
                className="btn"
                onClick={() => onAction({ type: 'ANSWER', accept: false })}
              >
                No
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => onAction({ type: 'ANSWER', accept: true })}
              >
                Yes
              </button>
            </div>
          )}

          {step.kind === 'choose' && canStop && (
            <div className="focus__actions">
              <button
                type="button"
                className="btn"
                onClick={() => onAction({ type: 'ANSWER', accept: false })}
              >
                {step.action === 'setAndOpen' ? 'Set nothing' : 'That will do'}
              </button>
            </div>
          )}

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
                data-tutorial="keep"
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
  if (step.kind === 'decide') return 'A card asks';
  if (step.kind === 'choose') {
    if (step.from === 'deck') return 'Search your deck';
    if (step.action === 'reorder') return 'Order your deck';
    if (step.action === 'toCityAnywhere') return 'Set them anywhere';
    if (step.action === 'moveHere') return 'Call them in';
    if (step.action === 'pay') return 'Pay the price';
    if (step.action === 'lock') return 'Lock them down';
    if (step.action === 'destroy') return 'Give up a card';
    return step.action === 'setAndOpen' ? 'Set and open' : 'Discard';
  }
  return 'Discard to seven';
}

function hint(step: HandStep): string {
  if (step.kind === 'decide') return step.text;
  if (step.kind === 'choose') {
    // The printed line first, in the card's own words: the player is being
    // interrupted by a card, and what it says is the whole reason they are
    // being asked. Then what to click, and how many times.
    const many = step.owed === 1 ? 'a card' : `${step.upTo ? 'up to ' : ''}${step.owed} cards`;
    const what =
      step.action === 'toHand'
        ? `Click ${many} to add to your hand — your deck is shuffled afterwards.`
        : step.action === 'toTrash'
          ? `Click ${many} to send to the graveyard — your deck is shuffled afterwards.`
          : step.action === 'toCity'
            ? `Click ${many} to set face down in this area — your deck is shuffled afterwards.`
            : step.action === 'setAndOpen'
              ? 'Click a card to set it in this area and open it at once, paying nothing.'
              : step.action === 'lock'
                ? `Click up to ${step.owed} to lock, or stop when you are done.`
                : step.action === 'pay'
                  ? 'Click a card to give up — one from your hand, a set card, or a character.'
                  : step.action === 'moveHere'
                    ? `Click up to ${step.owed} to bring here and unlock, or stop when you are done.`
                    : step.action === 'toCityAnywhere'
                      ? `Click a card, then the area it goes to — ${many} to place.`
                      : step.action === 'reorder'
                        ? 'Click the cards in the order you want them back — the last one you pick is drawn next.'
                        : step.action === 'destroy'
                          ? `Click ${many} of yours to destroy.`
                          : `Click ${many} to discard, or 🔍 to read one first.`;
    return `${step.text} ${what}`;
  }
  if (step.kind === 'mulligan') {
    if (step.costOfKeeping === 0) return 'Keep this hand, or shuffle it back and draw again.';
    const cards = step.costOfKeeping === 1 ? 'one card' : `${step.costOfKeeping} cards`;
    return `Keeping puts ${cards} on the bottom. Mulligan again to cost one more.`;
  }
  // The magnifier is worth naming: the click that picks a card cannot be
  // taken back, so the way to read one first should not have to be found.
  if (step.kind === 'bottom') {
    return step.owed === 1
      ? 'Click a card to put it on the bottom of your deck, or 🔍 to read it first.'
      : `Click ${step.owed} cards to put on the bottom of your deck, or 🔍 to read one first.`;
  }
  return step.over === 1
    ? 'Click a card to discard it, or 🔍 to read it first.'
    : `Click ${step.over} cards to discard, or 🔍 to read one first.`;
}
