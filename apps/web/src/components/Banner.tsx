import type { PhaseId, PlayerId } from '@berserk/engine';
import { BEAT_MS } from '@berserk/protocol';
import { useEffect, useState, type JSX } from 'react';
import { playPhase } from '../net/sound.js';
import type { Stage } from '../state/usePresentation.js';

/**
 * The banner that calls the turn and the phase.
 *
 * Whose turn it is is the heading; the phase sits under it. It arrives in two
 * pieces from opposite sides — the rules from the left, the bar and its text
 * from the right — and once they meet in the middle they keep drifting the
 * way they came, slowly, until the whole thing fades.
 *
 * Driven by the presentation queue rather than by watching the view: a turn
 * starting is a beat (`planBeats`), and it comes in the order the engine
 * resolved it — after the ability that fired at the end of the last turn,
 * before the one that fires at the start of this. A single action can
 * advance through several phases at once (Refresh and Draw resolve without
 * input, Rules.md §10), so the beat carries every phase it went through and
 * the subheading walks them, resting on the last.
 *
 * Phase banners are for **your** turn. The opponent's turn is announced once,
 * when it starts; narrating each of their phases as well would put a banner
 * over the board almost continuously, and the rail on the left already shows
 * the phase at all times.
 */

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
 * passed. The last one holds for whatever is left of the banner, so the walk
 * never outlives it.
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
  /** How long it stays on screen. */
  readonly hold: number;
}

export function Banner({
  stage,
  viewer,
}: {
  readonly stage: Stage | null;
  readonly viewer: PlayerId;
}): JSX.Element | null {
  const [shown, setShown] = useState<Announcement | null>(null);

  useEffect(() => {
    if (!stage) return;
    const { beat, key } = stage;
    if (beat.kind !== 'turn' && beat.kind !== 'phase') return;

    const yours = beat.player === viewer;
    const walked = beat.phases.map((id: PhaseId) => PHASE_LABEL[id] ?? id);
    setShown({
      key: String(key),
      title: yours ? 'Your Turn' : 'Opponent’s Turn',
      phases: walked.length > 0 ? walked : [''],
      yours,
      // The turn beat blocks for less than the banner shows: it drifts out
      // over its last stretch, and play may resume under that.
      hold: beat.kind === 'turn' ? BEAT_MS.TURN_BANNER : BEAT_MS.PHASE_BANNER,
    });
  }, [stage, viewer]);

  useEffect(() => {
    if (!shown) return;
    const timer = window.setTimeout(() => setShown(null), shown.hold);
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
    const gap = Math.min(STEP_MS, (shown.hold * 0.7) / (shown.phases.length - 1));
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
