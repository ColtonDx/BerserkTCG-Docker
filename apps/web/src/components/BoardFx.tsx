import type { PlayerView } from '@berserk/engine';
import { BEAT_MS } from '@berserk/protocol';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import {
  playCityTaken,
  playCityWake,
  playDeath,
  playDraw,
  playHit,
  playSchwing,
} from '../net/sound.js';
import type { Stage } from '../state/usePresentation.js';
import { CardImage } from './CardImage.js';

/**
 * What a blow looks like, and what a battle starting looks like.
 *
 * The board otherwise changes by numbers quietly moving: a character takes 4
 * damage and a small red figure appears under it, and a character dies by
 * ceasing to be drawn. Neither reads as an event, and in a game where damage
 * is the whole point that is the wrong thing to be silent about.
 *
 * Driven by the presentation queue: a `strike` beat is one band of blows
 * (Rules.md §11 ④) and whoever died of them, a `battle` beat is steel being
 * drawn (§11 ①), and `cityWakes` is a city turning face up to be fought over
 * (§5). The queue plays them in the order the
 * engine resolved them and one at a time, so this only has to draw the beat
 * on stage — the cutting of a batch into beats lives in `planBeats`, which
 * the server shares so the computer opponent waits for it.
 *
 * - a blow struck in a battle throws both cards at the city they are
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
/** How long a city takes to stand up and catch the light. Matches the CSS. */
const WAKE_MS = 900;

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

export function BoardFx({ view, stage }: { view: PlayerView; stage: Stage | null }): JSX.Element {
  const [hits, setHits] = useState<readonly Hit[]>([]);
  const [ghosts, setGhosts] = useState<readonly Ghost[]>([]);

  // The latest view, for the beat effect to read without re-running on it:
  // a view arriving mid-beat must not restart the blow or clear its timers.
  const viewRef = useRef(view);
  viewRef.current = view;

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

  // Timers that outlive a beat — a hit fading, a ghost fading — are cleared
  // only when the board goes away, never when the next beat arrives.
  const timers = useRef<number[]>([]);
  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
    },
    [],
  );

  useEffect(() => {
    if (!stage) return;
    const { beat, key } = stage;
    const later = (fn: () => void, ms: number): void => {
      timers.current.push(window.setTimeout(fn, ms));
    };

    if (beat.kind === 'battle') {
      playSchwing();
      return;
    }
    if (beat.kind === 'cityWakes') {
      playCityWake();
      wake(beat.city, later);
      return;
    }
    if (beat.kind === 'cityTaken') {
      // Rules.md §12 — the city pays two cards, and the label says so as it
      // arrives; the two draws are heard as it does, one after the other,
      // rather than at the top of the batch before the fight was even shown.
      playCityTaken();
      later(() => playDraw(1), 320);
      later(() => playDraw(1), 620);
      return;
    }
    if (beat.kind !== 'strike') return;
    // The blows land as the beat opens; a death is heard where it is seen,
    // behind the blow that caused it.
    if (beat.hits.length > 0) playHit();
    if (beat.deaths.length > 0) later(playDeath, beat.hits.length > 0 ? BEAT_MS.DEATH_AFTER : 0);

    const current = viewRef.current;
    const stamp = `${key}`;

    const beatHits: Hit[] = [];
    const lunged: { node: HTMLElement; toward: { x: number; y: number } }[] = [];
    beat.hits.forEach((hit, index) => {
      const target = remembered.current.get(hit.target)?.rect ?? null;
      if (target) {
        beatHits.push({
          key: `${stamp}:${index}`,
          at: target,
          amount: hit.amount,
          combat: hit.combat,
        });
      }
      // §11 ④ — a battle is fought over a city, so that is where the cards
      // meet. An effect reaches its victim without anybody moving.
      if (hit.combat) {
        const city = beat.city ?? cityOf(current, hit.source) ?? cityOf(current, hit.target);
        const at = city === null ? null : rectOf(`[data-city="${city}"] .city__card`);
        if (at) {
          for (const id of [hit.source, hit.target]) {
            const node = document.querySelector<HTMLElement>(`[data-card-id="${id}"]`);
            if (node) lunged.push({ node, toward: centre(at) });
          }
        }
      }
    });

    const beatGhosts: Ghost[] = [];
    beat.deaths.forEach((id, index) => {
      const last = remembered.current.get(id);
      if (last) beatGhosts.push({ key: `${stamp}:g${index}`, at: last.rect, defId: last.defId });
    });

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
      later(() => {
        node.style.setProperty('--clash-x', '0px');
        node.style.setProperty('--clash-y', '0px');
      }, CLASH_MS / 2);
      later(() => {
        node.classList.remove('card--clash');
        node.style.removeProperty('--clash-x');
        node.style.removeProperty('--clash-y');
      }, CLASH_MS);
    }

    if (beatHits.length > 0) {
      setHits((now) => [...now, ...beatHits]);
      later(
        () => setHits((now) => now.filter((hit) => !beatHits.some((h) => h.key === hit.key))),
        HIT_MS,
      );
    }

    if (beatGhosts.length > 0) {
      // At once, where the card stood: the board has just stopped drawing it
      // (its death is this beat's to reveal), and the ghost holds its place
      // for a moment before fading — the CSS delays the fade by
      // `DEATH_AFTER`, so the blow registers first.
      setGhosts((now) => [...now, ...beatGhosts]);
      later(
        () =>
          setGhosts((now) => now.filter((ghost) => !beatGhosts.some((g) => g.key === ghost.key))),
        BEAT_MS.DEATH_AFTER + BEAT_MS.DEATH_FADE,
      );
    }
  }, [stage]);

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

/**
 * A city waking up to be attacked. Rules.md §5 — the vanguard stepping
 * forward is what turns it face up, and the board used to cut straight to
 * its face. It stands up and catches the light instead.
 */
function wake(city: number, later: (fn: () => void, ms: number) => void): void {
  const node = document.querySelector<HTMLElement>(`[data-city="${city}"] .city__card`);
  if (!node) return;
  node.classList.add('city__card--waking');
  later(() => node.classList.remove('city__card--waking'), WAKE_MS);
}

/** Which area a card is standing in, for the city a battle is fought over. */
function cityOf(view: PlayerView, cardId: string): number | null {
  const card = view.cards[cardId];
  if (!card || card.zone !== 'city' || card.cityIndex === undefined) return null;
  return card.cityIndex;
}
