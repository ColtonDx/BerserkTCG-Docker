import { isHidden, type GameAction, type PlayerView, type VisibleCard } from '@berserk/engine';
import type { JSX } from 'react';
import { useState } from 'react';
import { CardImage } from './CardImage.js';
import { abilityOf, colourOf, costOf, nameOf } from '../state/useCardNames.js';
import { usePeek } from './usePeek.js';

/**
 * "Open Guts?" — and which cards to spend doing it.
 *
 * Opening costs cards out of hand (Rules.md §7), and *which* cards is the
 * player's decision, not the engine's. `legalActions` sends a payment that
 * would work, but it is only a suggestion: the reducer validates whatever
 * arrives, so anything legal the player picks here is accepted.
 *
 * Laid out like the mulligan step — board dimmed, hand forward and readable —
 * because it is the same kind of moment: look at your hand, choose, commit.
 *
 * The two piles are shown side by side: what you are buying on the left, what
 * you are spending on the right. They are different cards going to different
 * places, and the dialog used to show only the hand — which left the purchase
 * as a name in a heading and the price as a row of pips.
 *
 * Who the card is pointed at is *not* asked here. Rules.md §13 targeting
 * happens on the board once the cost is settled: picking a victim out of a row
 * of thumbnails tells you nothing about where they are standing, and this step
 * is about the hand.
 */

const COLOUR_NAME: Record<string, string> = {
  W: 'white',
  R: 'red',
  G: 'green',
  B: 'black',
};

interface Requirement {
  /** Colour letters needed, one entry per icon. */
  readonly colours: readonly string[];
  /** How many icons any card may pay. */
  readonly generic: number;
}

/** Reads `1WW` into one generic icon and two white ones. DesignNotes 8. */
export function readCost(notation: string): Requirement {
  const colours: string[] = [];
  let generic = 0;
  for (const token of notation.toUpperCase().matchAll(/(\d+)|([WRGB])/g)) {
    const [, digits, letter] = token;
    if (digits) generic += Number(digits);
    else if (letter) colours.push(letter);
  }
  return { colours, generic };
}

/**
 * Does this selection pay the cost exactly?
 *
 * Every coloured icon needs a card of that colour; generic icons take
 * anything. So it is enough that the totals match and each colour is covered
 * — whatever is left over necessarily falls to the generic icons.
 */
export function pays(need: Requirement, picked: readonly string[]): boolean {
  const total = need.colours.length + need.generic;
  if (picked.length !== total) return false;

  const have = new Map<string, number>();
  for (const defId of picked) {
    const colour = colourOf(defId);
    if (colour) have.set(colour, (have.get(colour) ?? 0) + 1);
  }
  const wanted = new Map<string, number>();
  for (const letter of need.colours) {
    const colour = COLOUR_NAME[letter] ?? letter;
    wanted.set(colour, (wanted.get(colour) ?? 0) + 1);
  }
  for (const [colour, count] of wanted) {
    if ((have.get(colour) ?? 0) < count) return false;
  }
  return true;
}

/** What is being paid for: a card coming out, or an ability being used. */
export type PayableAction = Extract<GameAction, { type: 'OPEN_CARD' | 'USE_ABILITY' }>;

interface Props {
  readonly view: PlayerView;
  /** The play the player is considering, as the engine offered it. */
  readonly action: PayableAction;
  readonly onConfirm: (action: GameAction) => void;
  readonly onCancel: () => void;
  readonly onPeek: (defId: string | null) => void;
  /** Read a card in full, without spending it. */
  readonly onInspect: (defId: string) => void;
}

export function PayFor({
  view,
  action,
  onConfirm,
  onCancel,
  onPeek,
  onInspect,
}: Props): JSX.Element {
  const card = view.cards[action.card];
  const defId = card && 'defId' in card ? card.defId : null;
  // An ability's price is not its card's. Griffith costs WW to open and his
  // ability costs one card to use (Rules.md §13), so the notation comes from
  // whichever of the two is being bought.
  const ability = action.type === 'USE_ABILITY' && defId ? abilityOf(defId, action.ability) : null;
  const notation =
    action.type === 'USE_ABILITY' ? (ability?.cost ?? '') : defId ? (costOf(defId) ?? '') : '';
  // If the catalogue has not arrived, an ability's price is still knowable
  // from the payment the engine suggested — the right number of cards, with no
  // colour demanded. Better than showing "it costs nothing" over a cost the
  // server is about to insist on.
  const need =
    action.type === 'USE_ABILITY' && !ability
      ? { colours: [], generic: action.pay?.length ?? 0 }
      : readCost(notation);
  const peek = usePeek(onPeek);

  // Nothing is chosen to begin with. The engine offers a legal payment and
  // pre-loading it would save a click, but it also quietly spends cards the
  // player never looked at — and which card leaves the hand is the whole
  // decision here (Rules.md §7). An empty start makes them all choices.
  const [picked, setPicked] = useState<readonly string[]>([]);

  const hand = (view.zoneOrder[`${view.viewer}:hand`] ?? [])
    .map((id) => view.cards[id])
    .filter((c): c is VisibleCard => c !== undefined && !isHidden(c));

  const toggle = (instanceId: string): void =>
    setPicked((current) =>
      current.includes(instanceId)
        ? current.filter((id) => id !== instanceId)
        : [...current, instanceId],
    );

  // The colours of what has been picked, which is what the cost is checked
  // against.
  const chosen = picked
    .map((id) => view.cards[id])
    .filter((c): c is VisibleCard => c !== undefined && !isHidden(c))
    .map((c) => String(c.defId));
  const settled = pays(need, chosen);
  const total = need.colours.length + need.generic;

  /** The chosen cards, in the order they were picked, for the right-hand column. */
  const paying = picked
    .map((id) => view.cards[id])
    .filter((c): c is VisibleCard => c !== undefined && !isHidden(c));

  return (
    <div className="focus pay" role="dialog" aria-modal="true">
      <div className="focus__panel">
        {/* What you are buying, and what you are spending, side by side.
         *
         * These are two different piles of cards and the dialog used to show
         * only one of them — the hand — leaving the card being opened as a
         * name in a heading and the cost as a row of pips. Which cards are
         * about to leave your hand for good is the decision here (Rules.md
         * §7), so both halves of it are on screen. */}
        <div className="pay__ledger">
          <div className="pay__side pay__side--buying">
            <h2 className="pay__heading">{ability ? 'Use ability?' : 'Open?'}</h2>
            {/* The card being bought is readable too — it is the one thing on
             * screen the decision is *about*, and it used to be the only card
             * here that could not be opened up and read. */}
            <div className="focus__slot">
              {defId ? (
                <CardImage defId={defId} className="pay__subject" />
              ) : (
                <div className="pay__subject pay__subject--unknown" />
              )}
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
            <span className="pay__name">{defId ? nameOf(defId) : 'This card'}</span>
            {/* Which of the card's abilities this is. A card may carry two,
             * and the price alone does not say which one is about to go off. */}
            {ability && <p className="pay__ability">{ability.text}</p>}
            <div className="pay__cost" aria-label={`Cost ${notation}`}>
              {need.colours.map((letter, index) => (
                <span
                  key={`c${index}`}
                  className={`pay__pip pay__pip--${COLOUR_NAME[letter] ?? 'any'}`}
                >
                  {letter}
                </span>
              ))}
              {need.generic > 0 && <span className="pay__pip pay__pip--any">{need.generic}</span>}
            </div>
          </div>

          <div className="pay__side pay__side--spending">
            <h2 className="pay__heading">
              Discarding
              <span className={settled ? 'pay__tally pay__tally--ok' : 'pay__tally'}>
                {picked.length} / {total}
              </span>
            </h2>
            {paying.length === 0 ? (
              <p className="pay__empty">
                {total === 0 ? 'Nothing — it costs nothing.' : 'Pick cards from your hand below.'}
              </p>
            ) : (
              <div className="pay__spent">
                {paying.map((c) => (
                  <button
                    key={c.instanceId}
                    type="button"
                    className="pay__spentcard"
                    title={`Put ${nameOf(c.defId)} back`}
                    aria-label={`Put ${nameOf(c.defId)} back`}
                    onClick={() => {
                      if (peek.consumed()) return;
                      toggle(c.instanceId);
                    }}
                    {...peek.bind(c.defId)}
                  >
                    <CardImage defId={c.defId} className="focus__art" />
                    <span className="pay__name">{nameOf(c.defId)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <p className="focus__hint">
          {total === 0
            ? 'It costs nothing.'
            : `Choose ${total} card${total > 1 ? 's' : ''} from your hand to pay ${notation}.`}
        </p>

        <div className="focus__hand">
          {hand.map((c) => {
            const chosen = picked.includes(c.instanceId);
            return (
              <div key={c.instanceId} className="focus__slot">
                <button
                  type="button"
                  className={chosen ? 'focus__card focus__card--paying' : 'focus__card'}
                  onClick={() => {
                    if (peek.consumed()) return;
                    toggle(c.instanceId);
                  }}
                  title={nameOf(c.defId)}
                  {...peek.bind(c.defId)}
                >
                  <CardImage defId={c.defId} className="focus__art" />
                </button>
                <button
                  type="button"
                  className="focus__look"
                  aria-label={`Inspect ${nameOf(c.defId)}`}
                  title={`Inspect ${nameOf(c.defId)}`}
                  onClick={() => {
                    peek.cancel();
                    onInspect(c.defId);
                  }}
                >
                  🔍
                </button>
              </div>
            );
          })}
        </div>

        <div className="focus__actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!settled}
            onClick={() => onConfirm({ ...action, pay: picked as never })}
          >
            {ability ? 'Use' : 'Open'}
          </button>
        </div>
      </div>
    </div>
  );
}
