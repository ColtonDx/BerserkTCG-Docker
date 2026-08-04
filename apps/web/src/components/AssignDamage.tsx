import type { CardInstanceId, GameAction, PlayerView } from '@berserk/engine';
import { useState, type JSX } from 'react';
import { CardImage } from './CardImage.js';
import { nameOf } from '../state/useCardNames.js';

/**
 * Splitting one character's Power among the enemies it is fighting.
 * Rules.md §11 ④.
 *
 * All of the Power has to be spent — a character cannot hold damage back — so
 * the Open button stays shut until the total is exact. The engine's suggestion
 * arrives pre-loaded, which is usually what a player wants: everything into
 * one target, because that is what kills something.
 */

interface Props {
  readonly view: PlayerView;
  /** The assignment the engine offered, as a starting point. */
  readonly action: Extract<GameAction, { type: 'ASSIGN_DAMAGE' }>;
  /** The striker's printed Power — the exact total to spend. */
  readonly power: number;
  readonly targets: readonly {
    readonly id: CardInstanceId;
    readonly defId: string;
    readonly hp: number;
    readonly damage: number;
  }[];
  readonly onConfirm: (action: GameAction) => void;
}

export function AssignDamage({ view, action, power, targets, onConfirm }: Props): JSX.Element {
  const striker = view.cards[action.card];
  const strikerId = striker && 'defId' in striker ? striker.defId : null;

  const [split, setSplit] = useState<Record<string, number>>(() => {
    const start: Record<string, number> = {};
    for (const hit of action.hits) start[hit.target] = (start[hit.target] ?? 0) + hit.amount;
    return start;
  });

  const spent = Object.values(split).reduce((sum, n) => sum + n, 0);
  const left = power - spent;

  const move = (id: string, by: number): void =>
    setSplit((current) => {
      const next = Math.max(0, (current[id] ?? 0) + by);
      if (by > 0 && left <= 0) return current;
      return { ...current, [id]: next };
    });

  return (
    <div className="focus assign" role="dialog" aria-modal="true">
      <div className="focus__panel">
        <h2 className="focus__title">{strikerId ? nameOf(strikerId) : 'This character'} strikes</h2>
        <p className="focus__hint">
          Split {power} damage among the enemies in this battle.{' '}
          <strong className={left === 0 ? 'assign__left assign__left--done' : 'assign__left'}>
            {left} left
          </strong>
        </p>

        <div className="assign__targets">
          {targets.map((target) => {
            const dealt = split[target.id] ?? 0;
            const lethal = target.damage + dealt >= target.hp;
            return (
              <div
                key={target.id}
                className={lethal ? 'assign__target assign__target--lethal' : 'assign__target'}
              >
                <CardImage defId={target.defId} className="assign__art" />
                <span className="assign__name">{nameOf(target.defId)}</span>
                <span className="assign__hp">
                  {target.damage + dealt} / {target.hp} damage{lethal ? ' — destroyed' : ''}
                </span>
                <div className="assign__dial">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => move(target.id, -1)}
                    disabled={dealt === 0}
                  >
                    −
                  </button>
                  <span className="assign__amount">{dealt}</span>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => move(target.id, 1)}
                    disabled={left <= 0}
                  >
                    +
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="focus__actions">
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
