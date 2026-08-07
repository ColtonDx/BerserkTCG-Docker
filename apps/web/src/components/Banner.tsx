import type { PhaseId, PlayerView } from '@berserk/engine';
import { BANNER_HOLD_MS } from '@berserk/protocol';
import { useEffect, useRef, useState, type JSX } from 'react';
import { playPhase } from '../net/sound.js';

/**
 * The banner that calls the turn and the phase.
 *
 * Whose turn it is is the heading; the phase sits under it. It arrives in two
 * pieces from opposite sides — the rules from the left, the bar and its text
 * from the right — and once they meet in the middle they keep drifting the
 * way they came, slowly, until the whole thing fades.
 *
 * Read off the view rather than the event feed: a single action can advance
 * through several phases at once — Refresh and Draw resolve without input
 * (Rules.md §10), and a phase with nothing in it is skipped — so the events
 * arrive in a burst. Three banners flickering past is unreadable, but simply
 * naming where play came to rest hides the fact that anything happened at
 * all. So it is one banner whose subheading walks the phases it went
 * through: Refresh, Draw, Open, Main, resting on the last.
 *
 * Phase banners are for **your** turn. The opponent's turn is announced once,
 * when it starts; narrating each of their phases as well would put a banner
 * over the board almost continuously, and the rail on the left already shows
 * the phase at all times.
 */

/**
 * How long the whole thing lasts, arrival and drift together. Matches the CSS,
 * and is shared with the server so the computer opponent does not play a card
 * underneath a banner.
 */
const HOLD_MS = BANNER_HOLD_MS;

/**
 * What each phase is called on the banner.
 *
 * `combat` is not a phase the engine has: Rules.md §10 ④(4) declares battle
 * from within Main and returns there afterwards, so there is no state to rest
 * on yet. The word is here so the banner is ready when the Battle phase is
 * built — until then it cannot fire.
 */
const PHASE_LABEL: Record<string, string> = {
  refresh: 'Refresh Phase',
  draw: 'Draw Phase',
  open: 'Open Phase',
  main: 'Main Phase',
  combat: 'Combat Step',
  end: 'End Step',
};

/**
 * How long each phase name shows while the subheading walks the ones just
 * passed. The last one holds for whatever is left of {@link HOLD_MS}, so the
 * banner never outlives the pacing the server plays to.
 *
 * Deliberately unhurried. Refresh and Draw resolve with no input at all and a
 * phase with nothing in it is skipped (Rules.md §10), so a single click can
 * cross three of them — at a glance the turn simply jumped, and the player is
 * left to work out what happened from the board. Each one now gets long
 * enough to read, and a sweep of air to go with it.
 */
const STEP_MS = 760;

interface Announcement {
  /** Changes whenever something new is announced, restarting the animation. */
  readonly key: string;
  readonly title: string;
  /** Every phase this advance went through, in order. At least one. */
  readonly phases: readonly string[];
  readonly yours: boolean;
}

export function Banner({ view }: { readonly view: PlayerView }): JSX.Element | null {
  const [shown, setShown] = useState<Announcement | null>(null);
  const previous = useRef<{ turn: number; actor: string; phase: number } | null>(null);

  const { turnNumber, activePlayer, phaseIndex } = view.turn;
  const playing = view.status.kind === 'playing';

  useEffect(() => {
    if (!playing) {
      previous.current = null;
      return;
    }

    const now = { turn: turnNumber, actor: String(activePlayer), phase: phaseIndex };
    const before = previous.current;
    previous.current = now;

    // Nothing to announce on the very first render: the player has just
    // watched the board deal, and does not need telling that it is turn one.
    if (!before) return;

    const yours = activePlayer === view.viewer;
    const turnChanged = before.turn !== now.turn || before.actor !== now.actor;
    const phaseChanged = before.phase !== now.phase;
    if (!turnChanged && !(phaseChanged && yours)) return;

    // Which phases this advance actually went through. A new turn starts at
    // the first one however far it then ran on; within a turn it is
    // everything after where we were. Either way the player sees the whole
    // journey rather than just its destination.
    const from = turnChanged ? 0 : before.phase + 1;
    const walked: string[] = [];
    for (let index = Math.max(0, from); index <= phaseIndex; index++) {
      const phase = view.phases[index];
      if (!phase) continue;
      walked.push(PHASE_LABEL[phase.id as PhaseId] ?? phase.name);
    }

    setShown({
      key: `${turnNumber}-${String(activePlayer)}-${phaseIndex}`,
      title: yours ? 'Your Turn' : 'Opponent’s Turn',
      phases: walked.length > 0 ? walked : [''],
      yours,
    });
  }, [playing, turnNumber, activePlayer, phaseIndex, view.viewer, view.phases]);

  useEffect(() => {
    if (!shown) return;
    const timer = window.setTimeout(() => setShown(null), HOLD_MS);
    return () => clearTimeout(timer);
  }, [shown]);

  // Walk the subheading through the phases just passed, then rest on the
  // last. Bounded by the banner's own life so the steps stay inside it
  // however many phases were skipped at once.
  const [step, setStep] = useState(0);
  useEffect(() => {
    setStep(0);
    if (!shown) return;
    // The first phase is announced with the banner itself; the rest each get
    // their own sweep as the subheading reaches them.
    playPhase();
    if (shown.phases.length < 2) return;
    const gap = Math.min(STEP_MS, (HOLD_MS * 0.7) / (shown.phases.length - 1));
    const timers = shown.phases.slice(1).map((_, index) =>
      window.setTimeout(
        () => {
          setStep(index + 1);
          playPhase();
        },
        gap * (index + 1),
      ),
    );
    return () => timers.forEach(clearTimeout);
  }, [shown]);

  if (!shown) return null;

  const phase = shown.phases[Math.min(step, shown.phases.length - 1)] ?? '';

  return (
    <div
      key={shown.key}
      className={shown.yours ? 'banner banner--yours' : 'banner'}
      role="status"
      aria-live="polite"
    >
      {/* From the left. */}
      <div className="banner__rules" aria-hidden="true">
        <span className="banner__line" />
        <span className="banner__line" />
      </div>

      {/* From the right, the text a beat behind the bar it sits on. */}
      <div className="banner__bar" aria-hidden="true" />
      <div className="banner__text">
        <span className="banner__title">{shown.title}</span>
        {/* Keyed on the name so each phase fades in as its turn comes. */}
        <span key={phase} className="banner__phase">
          {phase}
        </span>
      </div>
    </div>
  );
}
