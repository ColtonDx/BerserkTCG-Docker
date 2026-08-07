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
    const nextHits: Hit[] = [];
    const nextGhosts: Ghost[] = [];
    const lunged: { node: HTMLElement; toward: { x: number; y: number } }[] = [];

    events.forEach((event, index) => {
      if (event.type === 'DAMAGE_DEALT') {
        const target = remembered.current.get(event.target)?.rect ?? null;
        if (target) {
          nextHits.push({
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
              if (node) lunged.push({ node, toward: centre(at) });
            }
          }
        }
      }

      if (event.type === 'CHARACTER_DESTROYED') {
        const last = remembered.current.get(event.card);
        if (last) {
          nextGhosts.push({
            key: `${stamp}:${index}`,
            at: last.rect,
            defId: last.defId,
          });
        }
      }
    });

    if (nextHits.length === 0 && nextGhosts.length === 0 && lunged.length === 0) return;

    const timers: number[] = [];

    /**
     * Draw it — a beat after the action that caused it.
     *
     * Positions were measured when the events arrived, so the pause does not
     * make them stale: what moved in the meantime is the dialog going away,
     * which is the whole point of waiting.
     */
    const play = (): void => {
      // Out, then back: two writes against the transform transition the card
      // already has. `--clash-*` is composed into the base transform, so the
      // lunge keeps the fan rotation and the locked tilt instead of a keyframe
      // replacing the whole thing.
      //
      // Skipped outright when the player has asked for less motion — throwing
      // cards across the table is exactly what that setting is about. The
      // burst and the number still land, so the blow is not silent.
      for (const { node, toward } of stillness() ? [] : lunged) {
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

      if (nextHits.length > 0) {
        setHits((current) => [...current, ...nextHits]);
        timers.push(
          window.setTimeout(
            () =>
              setHits((current) =>
                current.filter((hit) => !nextHits.some((h) => h.key === hit.key)),
              ),
            HIT_MS,
          ),
        );
      }
      if (nextGhosts.length > 0) {
        setGhosts((current) => [...current, ...nextGhosts]);
        timers.push(
          window.setTimeout(
            () =>
              setGhosts((current) =>
                current.filter((ghost) => !nextGhosts.some((g) => g.key === ghost.key)),
              ),
            FADE_MS,
          ),
        );
      }
    };

    timers.push(window.setTimeout(play, SETTLE_MS));
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
