import type { BattleState, GameAction, PlayerView } from '@berserk/engine';
import type { JSX } from 'react';

/**
 * What the battle is asking of you, across the top of the board.
 *
 * The choices themselves are made on the cards — the characters that could
 * lead, or join, light up where they stand — so this says what the step is and
 * offers the one thing that is not a card: declining it.
 *
 * It appears for the defender too, on the attacker's turn, because Rules.md
 * §11 has them opening, committing and assigning damage throughout it.
 */

/**
 * What each step asks, and the line under it saying how to answer.
 *
 * The heading names the *decision* and the subheading says where to make it,
 * because every one of these is answered by clicking a card on the board
 * rather than anything in this bar. "Commit a character to the battle" read as
 * an instruction with nowhere to carry it out.
 */
const ASKS: Record<BattleState['step'], { yours: string; theirs: string; how?: string }> = {
  vanguard: {
    yours: 'Attack area {city}?',
    theirs: 'They are choosing who leads the attack',
    how: 'Click the character that will lead the attack',
  },
  opens: {
    yours: 'You may open one card in this area',
    theirs: 'They may open one card in this area',
    how: 'Click a Set Card here to open it',
  },
  commit: {
    yours: 'Defend area {city}?',
    theirs: 'They are committing characters',
    how: 'Click which characters to commit to the battle',
  },
  damage: {
    yours: 'Assign damage',
    theirs: 'They are assigning damage',
  },
};

/**
 * What declining means at this step.
 *
 * Plain words for a plain button: it ends your part of the step, and "Commit
 * no more" was doing more work than a button label should.
 */
const DECLINE: Record<BattleState['step'], string> = {
  vanguard: 'Call it off',
  opens: 'Open nothing',
  commit: 'Done',
  damage: '',
};

interface Props {
  readonly view: PlayerView;
  readonly battle: BattleState;
  readonly onAction: (action: GameAction) => void;
}

export function BattleBar({ view, battle, onAction }: Props): JSX.Element {
  const yours = battle.waitingOn === view.viewer;
  const attacking = battle.attacker === view.viewer;
  const ask = ASKS[battle.step];
  const canPass = view.legalActions.some((action) => action.type === 'BATTLE_PASS');

  const area = String(battle.city + 1);
  const heading = (yours ? ask.yours : ask.theirs).replace('{city}', area);

  return (
    <div className="battlebar" role="status">
      <span className="battlebar__where">
        Battle · area {area} · {attacking ? 'attacking' : 'defending'}
      </span>

      <span className="battlebar__lines">
        <span className={yours ? 'battlebar__ask battlebar__ask--yours' : 'battlebar__ask'}>
          {heading}
        </span>
        {/* Only to the player being asked: the other one is watching, and has
         * nothing to click. */}
        {yours && ask.how !== undefined && <span className="battlebar__how">{ask.how}</span>}
      </span>

      {yours && canPass && (
        <button type="button" className="btn" onClick={() => onAction({ type: 'BATTLE_PASS' })}>
          {DECLINE[battle.step]}
        </button>
      )}
    </div>
  );
}
