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

const ASKS: Record<BattleState['step'], { yours: string; theirs: string }> = {
  vanguard: {
    yours: 'Choose a character to lead the attack',
    theirs: 'They are choosing who leads the attack',
  },
  opens: {
    yours: 'You may open one card in this area',
    theirs: 'They may open one card in this area',
  },
  commit: {
    yours: 'Commit a character to the battle',
    theirs: 'They are committing characters',
  },
  damage: {
    yours: 'Assign damage',
    theirs: 'They are assigning damage',
  },
};

/** What declining means at this step, in the player's terms. */
const DECLINE: Record<BattleState['step'], string> = {
  vanguard: 'Call it off',
  opens: 'Open nothing',
  commit: 'Commit no more',
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

  return (
    <div className="battlebar" role="status">
      <span className="battlebar__where">
        Battle · area {battle.city + 1} · {attacking ? 'attacking' : 'defending'}
      </span>
      <span className={yours ? 'battlebar__ask battlebar__ask--yours' : 'battlebar__ask'}>
        {yours ? ask.yours : ask.theirs}
      </span>
      {yours && canPass && (
        <button type="button" className="btn" onClick={() => onAction({ type: 'BATTLE_PASS' })}>
          {DECLINE[battle.step]}
        </button>
      )}
    </div>
  );
}
