import type { CardInstanceId, GameEvent, PlayerView } from '@berserk/engine';
import { planBeats, type Beat } from '@berserk/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Plays each batch of events as a sequence of beats, one at a time — and
 * holds the board back to match.
 *
 * A single action can carry an open, the ability it fired, the blows it
 * landed, the deaths they caused and a city changing hands. Every overlay
 * used to watch the batch on its own and start its own timers in the same
 * frame, which is what put the city-taken card over the deaths that took it
 * and a Quick prompt over the reveal it was answering. Now there is one
 * queue: `planBeats` (shared with the server, so the computer opponent waits
 * exactly this long) cuts the batch, and this hook walks it.
 *
 * The board is part of the telling. The authoritative view arrives at once
 * and is never altered — but what is *drawn* is the view before the batch,
 * with each change revealed as the beat that explains it starts: a character
 * stays standing until its blow lands, the two cards a city pays arrive as
 * the city-taken card says so, a city stands up as the vanguard steps
 * forward. `shown` is that composite; nothing sends it anywhere.
 */

/** The beat on stage right now, keyed so a repeat of the same kind still restarts. */
export interface Stage {
  readonly beat: Beat;
  readonly key: number;
}

export interface Presentation {
  /** What is being shown, or null when nothing is. */
  readonly stage: Stage | null;
  /** Anything at all still to play, a settle included. Decisions wait for this. */
  readonly busy: boolean;
  /**
   * An overlay is holding the stage. A `settle` beat — cards still sliding —
   * does not count: it holds the overlays back but not the hand, so a
   * discard step never flickers between one card and the next.
   */
  readonly speaking: boolean;
  /** The view to draw: the board as the beats have told it so far. */
  readonly shown: PlayerView | null;
}

/** Beats that hold the stage against the hand, as opposed to merely pausing. */
const SPEAKS: ReadonlySet<Beat['kind']> = new Set([
  'turn',
  'battle',
  'cityWakes',
  'open',
  'reveal',
  'ability',
  'strike',
  'cityTaken',
]);

export function usePresentation(
  events: readonly GameEvent[],
  view: PlayerView | null,
): Presentation {
  const [stage, setStage] = useState<Stage | null>(null);
  // Bumped whenever the queue changes shape, so `shown` is recomputed.
  const [tick, setTick] = useState(0);
  const queue = useRef<Beat[]>([]);
  const running = useRef(false);
  const played = useRef<readonly GameEvent[] | null>(null);
  const timer = useRef<number | null>(null);
  const counter = useRef(0);
  // The view before the batch being played, which the board is drawn from
  // until each beat reveals its part. Null while nothing is queued.
  const previous = useRef<PlayerView | null>(null);
  // The view as of the last render, so a batch can tell what came before it.
  const lastView = useRef<PlayerView | null>(null);
  const latest = useRef(view);
  latest.current = view;

  useEffect(() => {
    if (!view || events.length === 0 || played.current === events) return;
    played.current = events;

    // Appended rather than replacing: a batch that lands while another is
    // still being shown waits its turn, which is the whole point.
    if (!running.current) previous.current = lastView.current;
    queue.current.push(...planBeats(events, view.viewer));
    setTick((t) => t + 1);
    if (running.current) return;

    const next = (): void => {
      const beat = queue.current.shift();
      if (!beat) {
        running.current = false;
        previous.current = null;
        setStage(null);
        setTick((t) => t + 1);
        return;
      }
      running.current = true;
      setStage({ beat, key: ++counter.current });
      setTick((t) => t + 1);
      // A beat of no length still has to be *seen* — a phase caption is
      // fire-and-forget, but React must render it before it is replaced.
      timer.current = window.setTimeout(next, Math.max(beat.ms, 50));
    };
    next();
  }, [events, view]);

  // After the batch effect above, so that effect saw the view before this one.
  useEffect(() => {
    lastView.current = view;
  }, [view]);

  // Leaving the match drops whatever was still to play.
  useEffect(() => {
    if (view !== null) return;
    queue.current = [];
    running.current = false;
    played.current = null;
    previous.current = null;
    if (timer.current !== null) clearTimeout(timer.current);
    setStage(null);
  }, [view]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  // Everything the beats still to come will reveal is held back.
  const shown = useMemo(() => {
    void tick;
    if (!view) return null;
    const before = previous.current;
    if (!before || queue.current.length === 0) return view;
    const cards = new Set<CardInstanceId>();
    const cities = new Set<number>();
    for (const beat of queue.current) {
      beat.reveals.cards.forEach((id) => cards.add(id));
      beat.reveals.cities.forEach((index) => cities.add(index));
    }
    return compose(view, before, cards, cities);
  }, [view, tick]);

  return {
    stage,
    busy: stage !== null,
    speaking: stage !== null && SPEAKS.has(stage.beat.kind),
    shown,
  };
}

/**
 * The view to draw: `view` with the held-back cards and cities as they were
 * in `before`.
 *
 * A held card is put back where it was — in its old zone's order, or in the
 * counts of a zone whose order the viewer cannot see — and one that was not
 * visible before (drawn off a deck the viewer cannot see into) is simply not
 * there yet. Nothing here is state: it is a picture, recomputed each render.
 */
function compose(
  view: PlayerView,
  before: PlayerView,
  heldCards: ReadonlySet<CardInstanceId>,
  heldCities: ReadonlySet<number>,
): PlayerView {
  if (heldCards.size === 0 && heldCities.size === 0) return view;

  const cards: Record<string, PlayerView['cards'][string]> = { ...view.cards };
  const counts: Record<string, number> = { ...view.zoneCounts };
  const order: Record<string, CardInstanceId[]> = {};
  for (const [key, ids] of Object.entries(view.zoneOrder)) {
    order[key] = ids.filter((id) => !heldCards.has(id));
  }

  for (const id of heldCards) {
    const now = view.cards[id];
    const old = before.cards[id];
    if (!now) continue;
    const nowKey = `${now.owner}:${now.zone}`;
    if (!old) {
      delete cards[id];
      counts[nowKey] = Math.max(0, (counts[nowKey] ?? 0) - 1);
      continue;
    }
    cards[id] = old;
    const oldKey = `${old.owner}:${old.zone}`;
    const oldOrder = before.zoneOrder[oldKey];
    if (oldOrder) {
      const at = oldOrder.indexOf(id);
      const list = order[oldKey] ?? (order[oldKey] = []);
      list.splice(at < 0 ? list.length : Math.min(at, list.length), 0, id);
    }
    if (oldKey !== nowKey) {
      counts[nowKey] = Math.max(0, (counts[nowKey] ?? 0) - 1);
      counts[oldKey] = (counts[oldKey] ?? 0) + 1;
    }
  }

  const cities = view.cities.map((city, index) =>
    heldCities.has(index) ? (before.cities[index] ?? city) : city,
  );

  return {
    ...view,
    cards,
    zoneOrder: order,
    zoneCounts: counts,
    cities,
    // City Level is the count of face-up cities (Rules.md §5), so it follows
    // the cities as drawn rather than the ones the engine already knows.
    cityLevel: cities.filter((city) => city.faceUp).length,
  };
}
