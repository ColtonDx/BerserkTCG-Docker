import type { GameAction, PlayerView, QuickTrigger } from '@berserk/engine';
import { isHidden } from '@berserk/engine';
import { useEffect, useMemo, useState, type JSX } from 'react';
import { CardImage } from './CardImage.js';
import { abilityOf, costOf, nameOf, textOf } from '../state/useCardNames.js';
import { mannerOf, quickStops, type Manner } from '../state/quickStops.js';
import { usePeek } from './usePeek.js';

/**
 * "They just did that — do you want to answer?"
 *
 * Rules.md §13 lets a Quick interject almost anywhere, and asking after every
 * action is how a game becomes a dialogue box. The engine already narrows it
 * to the moments in `DesignNotes` and to cards worth playing at that moment
 * (`rules.ts:quickRelevant`), so if this is on screen there is a real
 * decision behind it. This is about *how* it is put:
 *
 * - along the bottom edge, where the game puts what it is asking you, with
 *   the board left alone — a Quick is a decision about the board, and a
 *   modal over a dimmed table was asking it blind;
 * - as a hard stop inside a battle, and a countdown outside one, because
 *   the turn's edges are where a draw-two is nice to have and a fight is
 *   where a +2/+2 decides something. The player's own setting can widen or
 *   close that (`state/quickStops.ts`);
 * - with what each card would *do*, so "do I want to?" is answerable
 *   without opening the inspector.
 *
 * It is still an interrupt: the game is frozen behind it until it is
 * answered. What the player does not do, the client does for them — passing
 * — and says so.
 */

const BECAUSE: Record<QuickTrigger, string> = {
  turnStart: 'Their turn has begun',
  cardOpened: 'They opened a card',
  mainPhase: 'They have reached their Main phase',
  combat: 'They have declared a battle',
  attack: 'Their vanguard has stepped forward',
  beforeDamage: 'Damage is about to be dealt',
  turnEnd: 'They are ending their turn',
  response: 'An effect is about to resolve',
};

/** How long a soft window waits before passing on the player's behalf. */
const COUNTDOWN_MS = 8000;
/** How long an automatic pass is on screen, so silence has a reason. */
const AUTO_MS = 1100;
const TICK_MS = 100;

type Open = Extract<GameAction, { type: 'OPEN_CARD' }>;
type Use = Extract<GameAction, { type: 'USE_ABILITY' }>;

interface Props {
  readonly view: PlayerView;
  readonly trigger: QuickTrigger;
  /** Consider opening one — the player still has to pay for it. */
  readonly onConsiderOpen: (action: Open) => void;
  /** Use a Quick ability on a card already standing. Rules.md §13. */
  readonly onUseAbility: (action: Use) => void;
  readonly onPass: () => void;
  readonly onPeek: (defId: string | null) => void;
  /** Read a card in full before answering. */
  readonly onInspect: (defId: string) => void;
}

export function QuickPrompt({
  view,
  trigger,
  onConsiderOpen,
  onUseAbility,
  onPass,
  onPeek,
  onInspect,
}: Props): JSX.Element | null {
  const peek = usePeek(onPeek);
  // Read once, when the window opens: a setting changed mid-prompt applies
  // to the next one.
  const [manner] = useState<Manner>(() => mannerOf(trigger, view, quickStops()));

  const opens = view.legalActions.filter((action): action is Open => action.type === 'OPEN_CARD');
  // One entry per ability, however many targets it was offered with — the
  // board lights those up once the ability is chosen.
  const uses = useMemo(() => {
    const seen = new Set<string>();
    return view.legalActions.filter((action): action is Use => {
      if (action.type !== 'USE_ABILITY') return false;
      const id = `${action.card}:${action.ability}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }, [view.legalActions]);
  const nothing = opens.length === 0 && uses.length === 0;

  // Passing on the player's behalf: at once when there is nothing left to
  // offer (they opened their only Quick and the window stayed open for
  // another), after a breath when the setting says not to ask, and after
  // the countdown when it does.
  const [left, setLeft] = useState(COUNTDOWN_MS);
  useEffect(() => {
    if (nothing) {
      onPass();
      return;
    }
    if (manner === 'auto') {
      const timer = window.setTimeout(onPass, AUTO_MS);
      return () => clearTimeout(timer);
    }
    if (manner !== 'countdown') return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      const remaining = COUNTDOWN_MS - (Date.now() - started);
      if (remaining <= 0) {
        clearInterval(timer);
        onPass();
        return;
      }
      setLeft(remaining);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [manner, nothing, onPass]);

  if (nothing) return null;

  const classes = ['quickbar', `quickbar--${manner}`];

  // Rules.md §14 — what is on top of the stack, which is what a response
  // would resolve ahead of.
  const top = view.stack[view.stack.length - 1];
  const topCard = top ? view.cards[top.source] : undefined;
  const topDefId = topCard && !isHidden(topCard) ? String(topCard.defId) : null;
  const topLine = topDefId ? (abilityLine(topDefId, top?.ability ?? 0) ?? textOf(topDefId)) : null;

  if (manner === 'auto') {
    return (
      <div className={classes.join(' ')} role="status">
        <span className="quickbar__what">
          <span className="quickbar__quick">Quick</span>
          {BECAUSE[trigger]}
        </span>
        <span className="quickbar__auto">Passing for you — change in Settings</span>
      </div>
    );
  }

  return (
    <div className={classes.join(' ')} role="dialog" aria-label="Quick">
      <span className="quickbar__what">
        <span className="quickbar__quick">Quick</span>
        {BECAUSE[trigger]}
        <span className="quickbar__hint">
          {trigger === 'response'
            ? 'A Quick played now resolves first.'
            : view.battle
              ? 'You may act before the battle goes on.'
              : 'You may act out of turn.'}
        </span>
      </span>

      {trigger === 'response' && topDefId && (
        <div className="quickbar__pending" title="About to resolve">
          <CardImage defId={topDefId} className="quickbar__pending-art" />
          <span className="quickbar__about">
            <span className="quickbar__name">
              {top?.controller === view.viewer ? 'Your' : 'Their'} {nameOf(topDefId)}
            </span>
            {topLine && <span className="quickbar__line">{topLine}</span>}
          </span>
        </div>
      )}

      <div className="quickbar__cards">
        {opens.map((action) => {
          const card = view.cards[action.card];
          const defId = card && !isHidden(card) ? String(card.defId) : null;
          if (!defId) return null;
          return (
            <Choice
              key={`open:${action.card}`}
              defId={defId}
              price={costOf(defId)}
              line={textOf(defId)}
              onPick={() => onConsiderOpen(action)}
              onInspect={() => onInspect(defId)}
              peek={peek}
            />
          );
        })}
        {uses.map((action) => {
          const card = view.cards[action.card];
          const defId = card && !isHidden(card) ? String(card.defId) : null;
          if (!defId) return null;
          const printed = abilityOf(defId, action.ability);
          return (
            <Choice
              key={`use:${action.card}:${action.ability}`}
              defId={defId}
              price={printed?.cost ?? (printed?.lockSelf ? 'Tap' : null)}
              line={printed?.text ?? null}
              onPick={() => onUseAbility(action)}
              onInspect={() => onInspect(defId)}
              peek={peek}
            />
          );
        })}
      </div>

      <div className="quickbar__answer">
        <button type="button" className="btn btn--primary" onClick={onPass}>
          Pass
        </button>
        {manner === 'countdown' && (
          <span className="quickbar__timer" aria-hidden="true">
            <span
              className="quickbar__timer-fill"
              style={{ width: `${Math.max(0, (left / COUNTDOWN_MS) * 100)}%` }}
            />
          </span>
        )}
      </div>
    </div>
  );
}

/** The printed line of one ability, by its index on the card. */
function abilityLine(defId: string, index: number): string | null {
  return abilityOf(defId, String(index))?.text ?? null;
}

/**
 * One card on offer: the thumbnail, its price, and the printed line saying
 * what taking it would do. The magnifier is a sibling of the card, not
 * inside it — a button may not contain another interactive element — and
 * answering a Quick costs cards out of hand, which made this the one place a
 * card could not be read before it was committed to.
 */
function Choice({
  defId,
  price,
  line,
  onPick,
  onInspect,
  peek,
}: {
  readonly defId: string;
  readonly price: string | null;
  readonly line: string | null;
  readonly onPick: () => void;
  readonly onInspect: () => void;
  readonly peek: ReturnType<typeof usePeek>;
}): JSX.Element {
  return (
    <div className="quickbar__choice">
      <button
        type="button"
        className="quickbar__card"
        onClick={() => {
          if (peek.consumed()) return;
          onPick();
        }}
        {...peek.bind(defId)}
      >
        <CardImage defId={defId} className="quickbar__art" />
      </button>
      <span className="quickbar__about">
        <span className="quickbar__name">
          {nameOf(defId)}
          {price && <span className="quickbar__cost">{price}</span>}
        </span>
        {line && <span className="quickbar__line">{line}</span>}
      </span>
      <button
        type="button"
        className="focus__look quickbar__look"
        aria-label={`Inspect ${nameOf(defId)}`}
        title={`Inspect ${nameOf(defId)}`}
        onClick={() => {
          peek.cancel();
          onInspect();
        }}
      >
        🔍
      </button>
    </div>
  );
}
