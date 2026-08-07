import type { GameAction, PlayerView } from '@berserk/engine';
import { useRef, useState, type JSX } from 'react';
import { CardMenu, type CardMenuItem } from './CardMenu.js';
import { nameOf } from '../state/useCardNames.js';

/**
 * The game menu, in the header.
 *
 * Holds the things you do to the *match* rather than to a card or the turn:
 * leaving and conceding. Both end your game, so both ask first — they used to
 * be one-click buttons, and burying them in a menu makes a misclick likelier
 * to be a mistake rather than a decision.
 *
 * Any legal action that is neither about a card nor the turn's primary move
 * also lands here, so nothing the engine allows becomes unreachable.
 */

/** Done on the card itself — right-click or drag. */
const ON_THE_CARD = new Set<GameAction['type']>([
  'SET_CARD',
  'MOVE_CHARACTER',
  'OPEN_CARD',
  'DISCARD_CARD',
  'BOTTOM_CARD',
  'MULLIGAN',
  'KEEP_HAND',
]);

/** Handled by the floating turn button. */
const ON_THE_TURN = new Set<GameAction['type']>(['END_PHASE', 'PASS_PRIORITY']);

interface Props {
  readonly view: PlayerView;
  readonly onAction: (action: GameAction) => void;
  readonly onLeave: () => void;
  /** Settings, so nobody has to quit a match to turn the sound down. */
  readonly onSettings: () => void;
  readonly disabled?: boolean;
}

interface Confirm {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
}

export function GameMenu({
  view,
  onAction,
  onLeave,
  onSettings,
  disabled = false,
}: Props): JSX.Element {
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const button = useRef<HTMLButtonElement>(null);

  const over = view.status.kind === 'finished';

  const items: CardMenuItem[] = [
    { label: 'Settings', onPick: onSettings },
    {
      label: over ? 'Main menu' : 'Leave game',
      onPick: () => {
        if (over) return onLeave();
        setConfirm({
          title: 'Leave the game?',
          body: 'The match is still running. Leaving forfeits it.',
          confirmLabel: 'Leave',
          onConfirm: onLeave,
        });
      },
    },
  ];

  if (!over && view.legalActions.some((action) => action.type === 'CONCEDE')) {
    items.push({
      label: 'Concede',
      onPick: () =>
        setConfirm({
          title: 'Concede the match?',
          body: 'Your opponent wins immediately. This cannot be undone.',
          confirmLabel: 'Concede',
          onConfirm: () => onAction({ type: 'CONCEDE' }),
        }),
    });
  }

  for (const action of view.legalActions) {
    if (action.type === 'CONCEDE') continue;
    if (ON_THE_CARD.has(action.type) || ON_THE_TURN.has(action.type)) continue;
    items.push({ label: strayLabel(action, view), onPick: () => onAction(action) });
  }

  return (
    <>
      <button
        type="button"
        className="btn app__menu"
        ref={button}
        aria-haspopup="menu"
        aria-expanded={open !== null}
        onClick={() => {
          if (open) return setOpen(null);
          const rect = button.current?.getBoundingClientRect();
          setOpen({ x: rect ? rect.right - 176 : 0, y: rect ? rect.bottom + 6 : 0 });
        }}
      >
        Menu
      </button>

      {open && (
        <CardMenu x={open.x} y={open.y} title="Game" items={items} onClose={() => setOpen(null)} />
      )}

      {confirm && (
        <div className="confirm" role="dialog" aria-modal="true" aria-label={confirm.title}>
          <div className="confirm__panel">
            <h2 className="confirm__title">{confirm.title}</h2>
            <p className="confirm__body">{confirm.body}</p>
            <div className="confirm__actions">
              <button type="button" className="btn" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--danger"
                disabled={disabled}
                onClick={() => {
                  confirm.onConfirm();
                  setConfirm(null);
                }}
              >
                {confirm.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Anything not yet given a home of its own, so it stays reachable. */
function strayLabel(action: GameAction, view: PlayerView): string {
  switch (action.type) {
    case 'DECLARE_BATTLE':
      return `Battle at area ${action.city + 1}`;
    case 'USE_ABILITY': {
      // The wire names an ability by its position on the card, which means
      // nothing to a player — say whose ability it is instead.
      const card = view.cards[action.card];
      const defId = card && 'defId' in card ? card.defId : undefined;
      return defId ? `Use ${nameOf(defId)}’s ability` : 'Use ability';
    }
    default:
      return action.type.toLowerCase().replace(/_/g, ' ');
  }
}
