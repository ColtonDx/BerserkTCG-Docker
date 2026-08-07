import type { CardInstanceId, GameAction, PlayerView } from '@berserk/engine';
import { useState, type JSX } from 'react';
import { CardImage } from './CardImage.js';
import { nameOf } from '../state/useCardNames.js';

/**
 * Splitting one character's Power among the enemies it is fighting.
 * Rules.md §11 ④.
 *
 * All of the Power has to be spent — a character cannot hold damage back — so
 * Strike stays shut until the total is exact.
 *
 * Damage is dealt by *hitting people*: click a character to put one more into
 * them, click again for another. It used to be a row of − and + buttons around
 * a number, which is a spreadsheet of a decision — the eye ends up on the
 * arithmetic instead of on the board, and the thing a player actually wants to
 * know is who dies. So each blow lands on the card, the toll runs on the card,
 * and a character the assignment would kill wears a skull. Counting skulls is
 * the question being asked here.
 *
 * Nothing is assigned to begin with, for the same reason the payment dialog
 * starts empty: the engine's suggestion would spend a character's whole Power
 * on somebody the player never chose.
 */

interface Props {
  readonly view: PlayerView;
  /** The assignment the engine offered, which fixes the striker and the step. */
  readonly action: Extract<GameAction, { type: 'ASSIGN_DAMAGE' }>;
  /** The striker's current Power — the exact total to spend. */
  readonly power: number;
  readonly targets: readonly {
    readonly id: CardInstanceId;
    readonly defId: string;
    readonly hp: number;
    readonly damage: number;
  }[];
  readonly onConfirm: (action: GameAction) => void;
  /** Read a character in full before deciding where the blow goes. */
  readonly onInspect?: (defId: string) => void;
}

export function AssignDamage({
  view,
  action,
  power,
  targets,
  onConfirm,
  onInspect,
}: Props): JSX.Element {
  const striker = view.cards[action.card];
  const strikerId = striker && 'defId' in striker ? striker.defId : null;

  const [split, setSplit] = useState<Record<string, number>>({});

  const spent = Object.values(split).reduce((sum, n) => sum + n, 0);
  const left = power - spent;
  const dead = targets.filter((t) => t.damage + (split[t.id] ?? 0) >= t.hp).length;

  /** One more blow into this character, if there is any Power left to spend. */
  const strike = (id: string): void => {
    if (left <= 0) return;
    setSplit((current) => ({ ...current, [id]: (current[id] ?? 0) + 1 }));
  };

  /** Take one back. Nothing here is committed until Strike. */
  const unstrike = (id: string): void =>
    setSplit((current) => {
      const had = current[id] ?? 0;
      if (had <= 0) return current;
      return { ...current, [id]: had - 1 };
    });

  return (
    <div className="focus assign" role="dialog" aria-modal="true">
      <div className="focus__panel">
        <h2 className="focus__title">{strikerId ? nameOf(strikerId) : 'This character'} strikes</h2>
        <p className="focus__hint">
          <strong className={left === 0 ? 'assign__left assign__left--done' : 'assign__left'}>
            Assign damage {spent}/{power}
          </strong>{' '}
          — click a character to strike them, right-click to take one back.
          {dead > 0 && <span className="assign__toll"> 💀 {dead} would be destroyed</span>}
        </p>

        <div className="assign__targets">
          {targets.map((target) => {
            const dealt = split[target.id] ?? 0;
            const total = target.damage + dealt;
            const lethal = total >= target.hp;
            return (
              <div
                key={target.id}
                className={lethal ? 'assign__target assign__target--lethal' : 'assign__target'}
              >
                <div className="focus__slot">
                  <button
                    type="button"
                    className={dealt > 0 ? 'assign__hit assign__hit--struck' : 'assign__hit'}
                    disabled={left <= 0 && dealt === 0}
                    title={`Strike ${nameOf(target.defId)}`}
                    aria-label={`Strike ${nameOf(target.defId)}. ${total} of ${target.hp} damage.`}
                    onClick={() => strike(target.id)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      unstrike(target.id);
                    }}
                  >
                    <CardImage defId={target.defId} className="assign__art" />
                    {/* What this assignment is doing to them, on them. */}
                    {dealt > 0 && <span className="assign__dealt">-{dealt}</span>}
                    {lethal && (
                      <span className="assign__skull" aria-hidden="true">
                        💀
                      </span>
                    )}
                  </button>

                  {onInspect && (
                    <button
                      type="button"
                      className="focus__look"
                      aria-label={`Inspect ${nameOf(target.defId)}`}
                      title={`Inspect ${nameOf(target.defId)}`}
                      onClick={() => onInspect(target.defId)}
                    >
                      🔍
                    </button>
                  )}
                </div>

                <span className="assign__name">{nameOf(target.defId)}</span>
                <span className="assign__hp">
                  {total} / {target.hp} damage{lethal ? ' — destroyed' : ''}
                </span>
              </div>
            );
          })}
        </div>

        <div className="focus__actions">
          <button type="button" className="btn" disabled={spent === 0} onClick={() => setSplit({})}>
            Reset
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={left !== 0}
            onClick={() =>
              onConfirm({
                type: 'ASSIGN_DAMAGE',
                card: action.card,
                hits: Object.entries(split)
                  .filter(([, amount]) => amount > 0)
                  .map(([target, amount]) => ({ target: target as CardInstanceId, amount })),
              })
            }
          >
            Strike
          </button>
        </div>
      </div>
    </div>
  );
}
