import type { GameEvent, PlayerView } from '@berserk/engine';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { CardImage } from './CardImage.js';

/**
 * What a blow looks like.
 *
 * The board otherwise changes by numbers quietly moving: a character takes 4
 * damage and a small red figure appears under it, and a character dies by
 * ceasing to be drawn. Neither reads as an event, and in a game where damage
 * is the whole point that is the wrong thing to be silent about.
 *
 * Three things happen here, all driven by the events the server sent rather
 * than by the state they produced — the events say what *happened*, which is
 * what an animation is for:
 *
 * - a blow struck in a battle (§11 ④) throws both cards at the city they are
 *   fighting over, so the fight happens over the thing being fought for;
 * - damage from an effect (§13) lands on the card where it stands, since
 *   nobody moved to deliver it;
 * - a character that dies fades out from where it was standing.
 *
 * A card that has died is gone from the view by the time these run, so its
 * last position and face are remembered every render — there is nothing left
 * to measure once React has removed it.
 */

const HIT_MS = 620;
const CLASH_MS = 520;
const FADE_MS = 900;

/**
 * A beat between the action landing and the blow being drawn.
 *
 * Assigning damage is a decision made in a dialog, and the moment it is
 * confirmed the dialog goes and the whole exchange resolves — the swing, the
 * numbers and any deaths arriving together in the same frame the player was
 * still reading. The board needs a moment to become the thing being watched
 * before anything happens on it.
 */
const SETTLE_MS = 340;

/**
 * How long a death waits after the blow that caused it.
 *
 * A character dies *because* of a strike, and showing both at once reads as
 * the card simply vanishing — the player never sees what killed it. Long
 * enough for the burst and the number to register first, so the fade is
 * plainly the consequence rather than a separate mystery.
 */
const DEATH_AFTER_MS = 460;

/**
 * The gap between one band of strikes and the next.
 *
 * Rules.md §11 ④ resolves damage a Range band at a time, and a whole exchange
 * now arrives in one batch: the engine answers a strike that has only one
 * legal assignment rather than asking (`settleBattle`), so a 1v1 fight is
 * declared, fought and settled by a single click. Drawing every blow in that
 * batch simultaneously is what made combat go by too fast to follow.
 */
const BAND_MS = 540;

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface Hit {
  readonly key: string;
  readonly at: Rect;
  readonly amount: number;
  readonly combat: boolean;
}

interface Ghost {
  readonly key: string;
  readonly at: Rect;
  readonly defId: string | null;
}

/**
 * One moment of an exchange: the blows that land together, the cards that
 * lunge to deliver them, and whoever dies of them.
 *
 * Rules.md §11 ④ strikes a Range band at a time and the damage in a band lands
 * together, so a beat is the natural unit — and the batch an action returns
 * can hold several of them.
 */
interface Beat {
  readonly hits: Hit[];
  readonly ghosts: Ghost[];
  readonly lunged: { node: HTMLElement; toward: { x: number; y: number } }[];
}

const centre = (rect: Rect): { x: number; y: number } => ({
  x: rect.x + rect.w / 2,
  y: rect.y + rect.h / 2,
});

/** Has the player asked for less movement? Checked live, not cached. */
const stillness = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function rectOf(selector: string): Rect | null {
  const node = document.querySelector<HTMLElement>(selector);
  if (!node) return null;
  const box = node.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return null;
  return { x: box.left, y: box.top, w: box.width, h: box.height };
}

export function BoardFx({
  view,
  events,
}: {
  view: PlayerView;
  events: readonly GameEvent[];
}): JSX.Element {
  const [hits, setHits] = useState<readonly Hit[]>([]);
  const [ghosts, setGhosts] = useState<readonly Ghost[]>([]);

  // Every card's last known position and face. Written after each render, so
  // a card destroyed by the update that is about to arrive can still be drawn
  // where it was standing.
  const remembered = useRef(new Map<string, { rect: Rect; defId: string | null }>());

  useLayoutEffect(() => {
    for (const node of document.querySelectorAll<HTMLElement>('[data-card-id]')) {
      const id = node.dataset['cardId'];
      if (!id) continue;
      const box = node.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      const card = view.cards[id];
      remembered.current.set(id, {
        rect: { x: box.left, y: box.top, w: box.width, h: box.height },
        defId: card && 'defId' in card ? card.defId : null,
      });
    }
  });

  // Keyed to the event batch rather than the view: `recentEvents` sits there
  // until the next action, so watching the view would replay the same blow on
  // every update.
  const played = useRef<readonly GameEvent[] | null>(null);

  useEffect(() => {
    if (events.length === 0 || played.current === events) return;
    played.current = events;

    const stamp = Date.now();

    // The batch, cut into beats. One action can now carry a whole exchange —
    // several strikes and the deaths they cause — and playing all of it in one
    // frame is what made combat unreadable. Each `DAMAGE_DEALT` opens a beat;
    // deaths and any further blows join the beat they arrive in, so the order
    // on screen is the order the engine resolved them in.
    const beats: Beat[] = [];
    let beat: Beat | null = null;
    const open = (): Beat => {
      if (!beat) {
        beat = { hits: [], ghosts: [], lunged: [] };
        beats.push(beat);
      }
      return beat;
    };

    events.forEach((event, index) => {
      if (event.type === 'DAMAGE_DEALT') {
        // A blow that lands while a death is already pending starts a new
        // beat: two strikes in a row are two moments, not one.
        if (beat && beat.ghosts.length > 0) beat = null;
        const current = open();

        const target = remembered.current.get(event.target)?.rect ?? null;
        if (target) {
          current.hits.push({
            key: `${stamp}:${index}`,
            at: target,
            amount: event.amount,
            combat: event.combat,
          });
        }

        // §11 ④ — a battle is fought over a city, so that is where the cards
        // meet. An effect reaches its victim without anybody moving.
        if (event.combat) {
          const city = cityOf(view, event.source) ?? cityOf(view, event.target);
          const at = city === null ? null : rectOf(`[data-city="${city}"] .city__card`);
          if (at) {
            for (const id of [event.source, event.target]) {
              const node = document.querySelector<HTMLElement>(`[data-card-id="${id}"]`);
              if (node) current.lunged.push({ node, toward: centre(at) });
            }
          }
        }
      }

      if (event.type === 'CHARACTER_DESTROYED') {
        const last = remembered.current.get(event.card);
        if (last) {
          // Joins the beat of the blow that killed it, and is drawn a moment
          // later — see `DEATH_AFTER_MS`. A death with no strike before it in
          // this batch (an effect that destroys outright, §13) opens its own.
          open().ghosts.push({
            key: `${stamp}:${index}`,
            at: last.rect,
            defId: last.defId,
          });
        }
      }
    });

    if (beats.length === 0) return;

    const timers: number[] = [];

    /**
     * Draw one beat — the blows that land together, then the deaths they
     * caused.
     *
     * Positions were measured when the events arrived, so the delay does not
     * make them stale: what moves in the meantime is the dialog going away,
     * which is the whole point of waiting.
     */
    const play = (moment: Beat): void => {
      // Out, then back: two writes against the transform transition the card
      // already has. `--clash-*` is composed into the base transform, so the
      // lunge keeps the fan rotation and the locked tilt instead of a keyframe
      // replacing the whole thing.
      //
      // Skipped outright when the player has asked for less motion — throwing
      // cards across the table is exactly what that setting is about. The
      // burst and the number still land, so the blow is not silent.
      for (const { node, toward } of stillness() ? [] : moment.lunged) {
        const box = node.getBoundingClientRect();
        const from = centre({ x: box.left, y: box.top, w: box.width, h: box.height });

        // The class carries the transition, so it has to be *in effect* before
        // the offset is written — otherwise both land in one style recalc and
        // the browser has nothing to interpolate from. Reading a layout
        // property in between is what forces that.
        node.classList.add('card--clash');
        void node.offsetWidth;

        // A fraction of the way, not all of it: they meet over the city, they
        // do not land on top of it.
        node.style.setProperty('--clash-x', `${(toward.x - from.x) * 0.42}px`);
        node.style.setProperty('--clash-y', `${(toward.y - from.y) * 0.42}px`);
        timers.push(
          window.setTimeout(() => {
            node.style.setProperty('--clash-x', '0px');
            node.style.setProperty('--clash-y', '0px');
          }, CLASH_MS / 2),
          window.setTimeout(() => {
            node.classList.remove('card--clash');
            node.style.removeProperty('--clash-x');
            node.style.removeProperty('--clash-y');
          }, CLASH_MS),
        );
      }

      const { hits: beatHits, ghosts: beatGhosts } = moment;

      if (beatHits.length > 0) {
        setHits((current) => [...current, ...beatHits]);
        timers.push(
          window.setTimeout(
            () =>
              setHits((current) =>
                current.filter((hit) => !beatHits.some((h) => h.key === hit.key)),
              ),
            HIT_MS,
          ),
        );
      }

      if (beatGhosts.length > 0) {
        // Held back behind the blow that caused it. A card that vanishes in
        // the same frame as the hit reads as having disappeared rather than
        // having been killed — and with the engine settling forced
        // assignments itself, that frame is often the only one the player
        // gets. A death with no blow in front of it plays at once.
        const after = beatHits.length > 0 ? DEATH_AFTER_MS : 0;
        timers.push(
          window.setTimeout(() => {
            setGhosts((current) => [...current, ...beatGhosts]);
            timers.push(
              window.setTimeout(
                () =>
                  setGhosts((current) =>
                    current.filter((ghost) => !beatGhosts.some((g) => g.key === ghost.key)),
                  ),
                FADE_MS,
              ),
            );
          }, after),
        );
      }
    };

    // One beat after another, so an exchange reads as a sequence of blows
    // rather than arriving all at once. §11 ④ resolves a band at a time and
    // the engine can now run several bands inside a single action.
    beats.forEach((moment, index) => {
      timers.push(window.setTimeout(() => play(moment), SETTLE_MS + index * BAND_MS));
    });
    return () => timers.forEach(clearTimeout);
  }, [events, view]);

  if (hits.length === 0 && ghosts.length === 0) return <></>;

  return (
    <div className="fx" aria-hidden="true">
      {ghosts.map((ghost) => (
        <div
          key={ghost.key}
          className="fx__ghost"
          style={
            {
              left: `${ghost.at.x}px`,
              top: `${ghost.at.y}px`,
              width: `${ghost.at.w}px`,
              height: `${ghost.at.h}px`,
            } as CSSProperties
          }
        >
          {ghost.defId ? <CardImage defId={ghost.defId} /> : <div className="fx__ghost-back" />}
        </div>
      ))}

      {hits.map((hit) => {
        const at = centre(hit.at);
        return (
          <div
            key={hit.key}
            className={hit.combat ? 'fx__hit fx__hit--combat' : 'fx__hit fx__hit--effect'}
            style={{ left: `${at.x}px`, top: `${at.y}px` } as CSSProperties}
          >
            <span className="fx__burst" />
            <span className="fx__amount">-{hit.amount}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Which area a card is standing in, for the city a battle is fought over. */
function cityOf(view: PlayerView, cardId: string): number | null {
  const card = view.cards[cardId];
  if (!card || card.zone !== 'city' || card.cityIndex === undefined) return null;
  return card.cityIndex;
}
