import type { PlayerView, ViewCard } from '@berserk/engine';
import type { JSX } from 'react';
import { CardImage } from './CardImage.js';

/**
 * The deck and the graveyard, in the corners.
 *
 * The deck is a stack of backs — its order is the one secret nobody may see
 * (`view.ts`), so there is nothing to show but its thickness. The graveyard
 * shows the last card sent there face up, because the Trash is public in full
 * (Rules.md §15) and the top of it is what players actually want to know.
 *
 * The count sits over the pile and only while left Control is held; see
 * `useStatsKey`.
 */

interface Props {
  readonly view: PlayerView;
  readonly player: string;
  readonly kind: 'deck' | 'trash';
  /** Reveal the count. */
  readonly stats: boolean;
  /** Open the full graveyard. The deck has no equivalent: its order is secret. */
  readonly onOpen: () => void;
}

export function ZonePile({ view, player, kind, stats, onOpen }: Props): JSX.Element {
  const count = view.zoneCounts[`${player}:${kind}`] ?? 0;

  // The Trash is public, so its order comes through for both seats.
  const top =
    kind === 'trash' ? lastVisible(view, view.zoneOrder[`${player}:trash`] ?? []) : undefined;

  const label = kind === 'deck' ? 'Deck' : 'Graveyard';
  const empty = count === 0;
  // The Trash is public in full, so all of it can be looked through. A deck
  // is only ever a thickness — its order is the one thing nobody may see.
  const openable = kind === 'trash';

  return (
    <div
      className={`pile pile--${kind}${empty ? ' pile--empty' : ''}`}
      // Where a drawn card flies from. See `useCardFlip`.
      {...(kind === 'deck' ? { 'data-deck': player === view.viewer ? 'mine' : 'theirs' } : {})}
    >
      <div
        className="pile__card"
        role={openable ? 'button' : undefined}
        tabIndex={openable ? 0 : undefined}
        aria-label={openable ? `${label}: ${count}. Open to look through.` : `${label}: ${count}`}
        onClick={() => openable && onOpen()}
        onKeyDown={(event) => {
          if (openable && (event.key === 'Enter' || event.key === ' ')) onOpen();
        }}
      >
        {/* Two shims behind the face give the pile some thickness. */}
        {!empty && <span className="pile__shim pile__shim--2" />}
        {!empty && <span className="pile__shim pile__shim--1" />}

        {empty ? (
          <span className="pile__label">{label}</span>
        ) : top ? (
          <CardImage defId={top.defId} className="pile__art" />
        ) : (
          <span className="pile__back" aria-hidden="true" />
        )}
      </div>

      {stats && <span className="pile__count">{count}</span>}
    </div>
  );
}

/**
 * The most recent card in the pile whose identity came through. Anything
 * redacted is skipped rather than drawn as a blank — the graveyard is public,
 * so a hidden entry there would be a bug worth not papering over.
 */
function lastVisible(
  view: PlayerView,
  order: readonly string[],
): Extract<ViewCard, { defId: string }> | undefined {
  for (let index = order.length - 1; index >= 0; index--) {
    const id = order[index];
    const card = id ? view.cards[id] : undefined;
    if (card && 'defId' in card) return card;
  }
  return undefined;
}
