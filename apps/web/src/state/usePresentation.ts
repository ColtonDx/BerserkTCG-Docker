import type { GameEvent, PlayerId } from '@berserk/engine';
import { planBeats, type Beat } from '@berserk/protocol';
import { useEffect, useRef, useState } from 'react';

/**
 * Plays each batch of events as a sequence of beats, one at a time.
 *
 * A single action can carry an open, the ability it fired, the blows it
 * landed, the deaths they caused and a city changing hands. Every overlay
 * used to watch the batch on its own and start its own timers in the same
 * frame, which is what put the city-taken card over the deaths that took it
 * and a Quick prompt over the reveal it was answering. Now there is one
 * queue: `planBeats` (shared with the server, so the computer opponent waits
 * exactly this long) cuts the batch, and this hook walks it.
 *
 * The board itself still renders the new view the moment it arrives —
 * nothing here delays the authoritative state. What is sequenced is the
 * *telling*: banners, reveals, blows, and the prompts that wait until the
 * telling is done.
 */

/** The beat on stage right now, keyed so a repeat of the same kind still restarts. */
export interface Stage {
  readonly beat: Beat;
  readonly key: number;
}

export interface Presentation {
  /** What is being shown, or null when nothing is. */
  readonly stage: Stage | null;
  /**
   * Whether the screen is being spoken over. A `settle` beat — cards still
   * sliding — does not count: it holds the overlays back but not the
   * player, so a discard step never flickers between cards. Everything else
   * does, and a decision is not asked for until it is over.
   */
  readonly busy: boolean;
}

/** Beats that hold the stage against a prompt, as opposed to merely pausing. */
const SPEAKS: ReadonlySet<Beat['kind']> = new Set([
  'turn',
  'battle',
  'open',
  'ability',
  'strike',
  'cityTaken',
]);

export function usePresentation(
  events: readonly GameEvent[],
  viewer: PlayerId | undefined,
): Presentation {
  const [stage, setStage] = useState<Stage | null>(null);
  const queue = useRef<Beat[]>([]);
  const running = useRef(false);
  const played = useRef<readonly GameEvent[] | null>(null);
  const timer = useRef<number | null>(null);
  const counter = useRef(0);

  useEffect(() => {
    if (viewer === undefined || events.length === 0 || played.current === events) return;
    played.current = events;

    // Appended rather than replacing: a batch that lands while another is
    // still being shown waits its turn, which is the whole point.
    queue.current.push(...planBeats(events, viewer));
    if (running.current) return;

    const next = (): void => {
      const beat = queue.current.shift();
      if (!beat) {
        running.current = false;
        setStage(null);
        return;
      }
      running.current = true;
      setStage({ beat, key: ++counter.current });
      // A beat of no length still has to be *seen* — a phase caption is
      // fire-and-forget, but React must render it before it is replaced.
      timer.current = window.setTimeout(next, Math.max(beat.ms, 50));
    };
    next();
  }, [events, viewer]);

  // Leaving the match drops whatever was still to play.
  useEffect(() => {
    if (viewer !== undefined) return;
    queue.current = [];
    running.current = false;
    played.current = null;
    if (timer.current !== null) clearTimeout(timer.current);
    setStage(null);
  }, [viewer]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  return { stage, busy: stage !== null && SPEAKS.has(stage.beat.kind) };
}
