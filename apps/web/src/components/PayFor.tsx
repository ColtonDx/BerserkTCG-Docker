import { isHidden, type GameAction, type PlayerView, type VisibleCard } from '@berserk/engine';
import type { JSX } from 'react';
import { useState } from 'react';
import { CardImage } from './CardImage.js';
import { colourOf, costOf, nameOf, statsOf } from '../state/useCardNames.js';
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

interface Props {
  readonly view: PlayerView;
  /** The open the player is considering, as the engine offered it. */
  readonly action: Extract<GameAction, { type: 'OPEN_CARD' }>;
  readonly onConfirm: (action: GameAction) => void;
  readonly onCancel: () => void;
  readonly onPeek: (defId: string | null) => void;
}

export function PayFor({ view, action, onConfirm, onCancel, onPeek }: Props): JSX.Element {
  const card = view.cards[action.card];
  const defId = card && 'defId' in card ? card.defId : null;
  const notation = defId ? (costOf(defId) ?? '') : '';
  const need = readCost(notation);
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

  // Rules.md §13 — some cards ask who they are pointed at. The engine offers
  // a legal choice with the action and accepts any other legal one, so the
  // candidates are read back off it: everything face-up in the same area,
  // which is what every card in the set that asks means by "this area".
  const asked = action.targets?.length ?? 0;
  const source = card && !isHidden(card) ? card : null;
  const candidates =
    asked === 0 || !source
      ? []
      : Object.values(view.cards).filter(
          (c): c is VisibleCard =>
            !isHidden(c) &&
            c.zone === 'city' &&
            c.cityIndex === source.cityIndex &&
            // The card being opened is still a face-down Set Card here, but
            // it will be standing in the area when its ability resolves — so
            // it can be pointed at, and a lone character means itself.
            (c.faceUp || c.instanceId === source.instanceId) &&
            statsOf(String(c.defId)) !== null,
        );
  const [aimed, setAimed] = useState<string | null>(action.targets?.[0] ?? null);
  const needsTarget = asked > 0 && candidates.length > 0;
  const aimedOk = !needsTarget || aimed !== null;

  return (
    <div className="focus pay" role="dialog" aria-modal="true">
      <div className="focus__panel">
        <h2 className="focus__title">Open {defId ? nameOf(defId) : 'this card'}?</h2>
        <p className="focus__hint">
          {total === 0
            ? 'It costs nothing.'
            : `Choose ${total} card${total > 1 ? 's' : ''} from your hand to pay ${notation}.`}
        </p>

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
          <span className={settled ? 'pay__tally pay__tally--ok' : 'pay__tally'}>
            {picked.length} / {total}
          </span>
        </div>

        <div className="focus__hand">
          {hand.map((c) => {
            const chosen = picked.includes(c.instanceId);
            return (
              <button
                key={c.instanceId}
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
            );
          })}
        </div>

        {needsTarget && (
          <>
            <p className="focus__hint pay__aim">Then choose who it affects.</p>
            <div className="focus__hand">
              {candidates.map((c) => (
                <button
                  key={c.instanceId}
                  type="button"
                  className={
                    aimed === c.instanceId ? 'focus__card focus__card--aimed' : 'focus__card'
                  }
                  onClick={() => setAimed(c.instanceId)}
                  aria-pressed={aimed === c.instanceId}
                  {...peek.bind(String(c.defId))}
                >
                  <CardImage defId={String(c.defId)} className="focus__art" />
                  <span className="focus__name">{nameOf(String(c.defId))}</span>
                </button>
              ))}
            </div>
          </>
        )}

        <div className="focus__actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!settled || !aimedOk}
            onClick={() =>
              onConfirm({
                ...action,
                pay: picked as never,
                ...(needsTarget && aimed ? { targets: [aimed] as never } : {}),
              })
            }
          >
            Open
          </button>
        </div>
      </div>
    </div>
  );
}
