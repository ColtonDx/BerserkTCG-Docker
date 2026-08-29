import type { CardInstanceId, GameEvent, PhaseId, PlayerId } from '@berserk/engine';

/**
 * How a batch of events is *shown*, and how long that takes.
 *
 * One action can carry a whole exchange — an open, the ability it fires, the
 * blows it lands, the deaths they cause, a city changing hands and the draws
 * that go with it — and the engine hands all of it over at once. Drawing it
 * all in one frame is what made cards vanish for no reason and a fight go by
 * before it could be read. So the batch is cut into **beats**, one moment
 * each, and played in order; nothing starts until the beat before it is done.
 *
 * This is shared between the client and the server for one reason: the
 * computer opponent must not move again while the last move is still being
 * drawn, and the only way to know how long that takes is to ask the same
 * function the client plays from. There used to be a table of guesses on
 * each side and a comment saying to raise them together.
 *
 * Pure: events in, beats out. Nothing here touches the DOM or the clock.
 */

/** A blow that landed, as a beat draws it. */
export interface Hit {
  readonly source: CardInstanceId;
  readonly target: CardInstanceId;
  readonly amount: number;
  /** Struck in a battle (Rules.md §11 ④) rather than dealt by an effect (§13). */
  readonly combat: boolean;
}

/**
 * The board changes a beat accounts for. Until the beat plays, the client
 * draws these cards and cities as they were before the batch — a character
 * stays standing until its blow lands, the two cards a city pays arrive as
 * the city-taken card says so. A board that has already moved on makes the
 * telling a replay of something the player saw happen in one frame.
 */
export interface Reveals {
  readonly cards: readonly CardInstanceId[];
  readonly cities: readonly number[];
}

const NOTHING: Reveals = { cards: [], cities: [] };

interface Told {
  readonly reveals: Reveals;
}

export type Beat = Told & Moment;

type Moment =
  /**
   * A turn beginning, announced with a banner that walks the phases the turn
   * ran through before stopping. Rules.md §10.
   */
  | {
      readonly kind: 'turn';
      readonly player: PlayerId;
      readonly turnNumber: number;
      readonly phases: readonly PhaseId[];
      readonly ms: number;
    }
  /**
   * Phases advanced within a turn. Only the viewer's own are announced — the
   * opponent's phases would put a banner over the board almost continuously,
   * and the rail on the left already shows where the turn is.
   */
  | {
      readonly kind: 'phase';
      readonly player: PlayerId;
      readonly phases: readonly PhaseId[];
      readonly ms: number;
    }
  /**
   * Cards sliding into place — a set, a draw, a move, a lock — which the
   * board animates from the state change itself. A beat so that nothing is
   * held up over a board that is still moving.
   */
  | { readonly kind: 'settle'; readonly ms: number }
  /** A battle declared: steel drawn. Rules.md §11 ①. */
  | {
      readonly kind: 'battle';
      readonly city: number;
      readonly attacker: PlayerId;
      readonly ms: number;
    }
  /**
   * A city turning face up. Rules.md §5 — it happens as the vanguard steps
   * forward, once the attack can no longer be called off.
   */
  | { readonly kind: 'cityWakes'; readonly city: number; readonly ms: number }
  /**
   * A card opened, held up to be read. Rules.md §7. Carries the printed line
   * of any ability the open fired, so one card is shown once with what it
   * did rather than twice.
   */
  | {
      readonly kind: 'open';
      readonly card: CardInstanceId;
      readonly player: PlayerId;
      readonly ability?: string;
      /** The ability went off and found nothing to act on. */
      readonly fizzled?: boolean;
      readonly ms: number;
    }
  /**
   * A card shown to both players on its way into a hand — a search that
   * says "reveal it". Rules.md §13.
   */
  | {
      readonly kind: 'reveal';
      readonly card: CardInstanceId;
      readonly player: PlayerId;
      readonly ms: number;
    }
  /** An ability going off on a card already on the table. Rules.md §13. */
  | {
      readonly kind: 'ability';
      readonly card: CardInstanceId;
      readonly player: PlayerId;
      readonly text: string;
      readonly fizzled?: boolean;
      readonly ms: number;
    }
  /**
   * Blows landing together, and whoever dies of them. Rules.md §11 ④ strikes
   * a Range band at a time and the damage in a band lands together, so a
   * band is one beat; an effect's damage is another.
   */
  | {
      readonly kind: 'strike';
      readonly hits: readonly Hit[];
      readonly deaths: readonly CardInstanceId[];
      /**
       * The city a battle's blows are struck over, when the batch says
       * which — the striker may be in the Trash by the time the beat plays,
       * so the client cannot always read it off the board.
       */
      readonly city: number | null;
      readonly ms: number;
    }
  /** A city changing hands. Rules.md §12 — the win condition moving. */
  | {
      readonly kind: 'cityTaken';
      readonly city: number;
      readonly player: PlayerId;
      readonly ms: number;
    };

/**
 * How long each kind of beat holds the stage.
 *
 * The client's overlays read their own lengths from here as well, so the
 * time the server waits *is* the time the screen is busy. `TURN` is shorter
 * than the banner stays on screen: it drifts out over its last stretch, and
 * play may resume under that.
 */
export const BEAT_MS = {
  /** The turn banner blocks for this long; it stays on screen for `TURN_BANNER`. */
  TURN: 3200,
  TURN_BANNER: 4200,
  /** A phase walk on your own turn does not block anything: it is a caption. */
  PHASE: 0,
  PHASE_BANNER: 3000,
  /** How long a card takes to slide between zones, or turn to lock. */
  SETTLE: 620,
  /** A moment for a dialog to leave before anything happens on the board. */
  BREATH: 340,
  BATTLE: 700,
  /** A city standing up into the light. Matches the CSS. */
  CITY_WAKES: 900,
  OPEN: 1700,
  /** An open that also reads out what it did needs longer. */
  OPEN_WITH_ABILITY: 2400,
  ABILITY: 1900,
  /** A card revealed on its way into a hand: long enough to read the name. */
  REVEAL: 1500,
  /** A band of blows with nobody dying of them. */
  STRIKE: 760,
  /** A death waits behind the blow that caused it, then fades. */
  DEATH_AFTER: 460,
  DEATH_FADE: 900,
  CITY_TAKEN: 2200,
} as const;

/** Events whose only visible result is a card sliding or turning. */
const SLIDES: ReadonlySet<GameEvent['type']> = new Set([
  'CARD_SET',
  'CARD_DRAWN',
  'CARD_RETURNED',
  'CARD_TRASHED',
  'CHARACTER_MOVED',
  'DECK_SEARCHED',
  'CARDS_UNLOCKED',
  'VANGUARD_DESIGNATED',
  'CHARACTER_COMMITTED',
  'CARD_BOTTOMED',
  'CARD_ATTACHED',
]);

/** What an event changes on the board, if anything a beat should hold back. */
function changes(event: GameEvent): { card?: CardInstanceId; city?: number } | null {
  switch (event.type) {
    case 'CARD_OPENED':
    case 'CARD_DRAWN':
    case 'DECK_SEARCHED':
    case 'CARD_RETURNED':
    case 'CARD_TRASHED':
    case 'CHARACTER_MOVED':
    case 'CHARACTER_DESTROYED':
      return { card: event.card };
    case 'DAMAGE_DEALT':
      return { card: event.target };
    case 'CITY_FLIPPED':
    case 'CITY_OCCUPIED':
      return { city: event.city };
    default:
      return null;
  }
}

/**
 * Cuts a batch into the beats that show it, in the order the engine resolved
 * them, from the point of view of one seat.
 *
 * The seat matters in one place: phase banners are for your own turn only.
 * Everything else is shown to both players alike.
 */
export function planBeats(events: readonly GameEvent[], viewer: PlayerId): Beat[] {
  // Beats as they are made, each with the index of the event that opened it,
  // so what happened *after* that event and before the next beat can be
  // charged to it below.
  const made: { anchor: number; beat: Moment }[] = [];

  // Abilities an open fired are folded into the open — one card, shown once,
  // with what it did — so those `ABILITY_RESOLVED` events are spoken for.
  const folded = new Set<number>();
  const fizzled = new Set<CardInstanceId>();
  events.forEach((event) => {
    if (event.type === 'ABILITY_FIZZLED') fizzled.add(event.card);
  });

  // Where the batch's battle, if any, is being fought. Rules.md §11.
  const battleCity = events.reduce<number | null>((found, event) => {
    if (event.type === 'BATTLE_DECLARED' || event.type === 'BATTLE_ENDED') return event.city;
    return found;
  }, null);

  // A strike beat being assembled: blows land together, then the deaths.
  let strike: { anchor: number; hits: Hit[]; deaths: CardInstanceId[] } | null = null;
  const closeStrike = (): void => {
    if (!strike) return;
    const { anchor, hits, deaths } = strike;
    // A death holds where it stood for a moment and then fades, whether or
    // not a blow is drawn in front of it.
    const ms = deaths.length > 0 ? BEAT_MS.DEATH_AFTER + BEAT_MS.DEATH_FADE : BEAT_MS.STRIKE;
    const combat = hits.some((hit) => hit.combat);
    made.push({
      anchor,
      beat: { kind: 'strike', hits, deaths, city: combat ? battleCity : null, ms },
    });
    strike = null;
  };

  events.forEach((event, index) => {
    if (event.type !== 'DAMAGE_DEALT' && event.type !== 'CHARACTER_DESTROYED') closeStrike();

    switch (event.type) {
      case 'TURN_STARTED': {
        // The phases the turn ran through before it stopped to ask.
        const phases: PhaseId[] = [];
        for (const later of events.slice(index + 1)) {
          if (later.type === 'TURN_STARTED') break;
          if (later.type === 'PHASE_CHANGED') phases.push(later.phaseId);
        }
        made.push({
          anchor: index,
          beat: {
            kind: 'turn',
            player: event.player,
            turnNumber: event.turnNumber,
            phases,
            ms: BEAT_MS.TURN,
          },
        });
        break;
      }

      case 'PHASE_CHANGED': {
        // Spoken for by the turn banner if one is in this batch before it.
        const announced = events.slice(0, index).some((earlier) => earlier.type === 'TURN_STARTED');
        if (announced || event.player !== viewer) break;
        const last = made[made.length - 1];
        if (last && last.beat.kind === 'phase') {
          last.beat = { ...last.beat, phases: [...last.beat.phases, event.phaseId] };
        } else {
          made.push({
            anchor: index,
            beat: {
              kind: 'phase',
              player: event.player,
              phases: [event.phaseId],
              ms: BEAT_MS.PHASE,
            },
          });
        }
        break;
      }

      case 'BATTLE_DECLARED':
        made.push({
          anchor: index,
          beat: {
            kind: 'battle',
            city: event.city,
            attacker: event.attacker,
            ms: BEAT_MS.BATTLE,
          },
        });
        break;

      case 'CITY_FLIPPED':
        if (event.faceUp) {
          made.push({
            anchor: index,
            beat: { kind: 'cityWakes', city: event.city, ms: BEAT_MS.CITY_WAKES },
          });
        }
        break;

      case 'CARD_OPENED': {
        // The first ability this card fires in the batch rides with the open.
        const firedAt = events.findIndex(
          (later, at) =>
            at > index && later.type === 'ABILITY_RESOLVED' && later.card === event.card,
        );
        const fired = firedAt >= 0 ? events[firedAt] : undefined;
        if (firedAt >= 0) folded.add(firedAt);
        // Resolved in this batch, or merely pending (Rules.md §14): either
        // way the card is held up once, with its line.
        const pendingLine = events.find(
          (later, at) => at > index && later.type === 'EFFECT_PENDING' && later.card === event.card,
        );
        const ability =
          fired && fired.type === 'ABILITY_RESOLVED'
            ? fired.text
            : pendingLine && pendingLine.type === 'EFFECT_PENDING'
              ? pendingLine.text
              : undefined;
        made.push({
          anchor: index,
          beat: {
            kind: 'open',
            card: event.card,
            player: event.player,
            ...(ability !== undefined ? { ability } : {}),
            ...(ability !== undefined && fizzled.has(event.card) ? { fizzled: true } : {}),
            ms: ability === undefined ? BEAT_MS.OPEN : BEAT_MS.OPEN_WITH_ABILITY,
          },
        });
        break;
      }

      case 'CARD_REVEALED':
        made.push({
          anchor: index,
          beat: { kind: 'reveal', card: event.card, player: event.player, ms: BEAT_MS.REVEAL },
        });
        break;

      case 'ABILITY_RESOLVED':
        if (folded.has(index)) break;
        made.push({
          anchor: index,
          beat: {
            kind: 'ability',
            card: event.card,
            player: event.player,
            text: event.text,
            ...(fizzled.has(event.card) ? { fizzled: true } : {}),
            ms: BEAT_MS.ABILITY,
          },
        });
        break;

      case 'DAMAGE_DEALT': {
        // A blow that lands while a death is already pending starts a new
        // beat: two strikes in a row are two moments, not one.
        if (strike && strike.deaths.length > 0) closeStrike();
        strike ??= { anchor: index, hits: [], deaths: [] };
        strike.hits.push({
          source: event.source,
          target: event.target,
          amount: event.amount,
          combat: event.combat,
        });
        break;
      }

      case 'CHARACTER_DESTROYED':
        // Joins the blow that killed it. A death with no strike before it (an
        // effect that destroys outright, §13) opens a beat of its own.
        strike ??= { anchor: index, hits: [], deaths: [] };
        strike.deaths.push(event.card);
        break;

      case 'CITY_OCCUPIED':
        // A city falling vacant pays nobody and is not announced.
        if (event.player !== null) {
          made.push({
            anchor: index,
            beat: {
              kind: 'cityTaken',
              city: event.city,
              player: event.player,
              ms: BEAT_MS.CITY_TAKEN,
            },
          });
        }
        break;

      default:
        break;
    }
  });
  closeStrike();

  // Charge every board change to the beat it happened under: the last one
  // opened at or before it. A change before any beat is shown at once — the
  // cost paid for an open leaves the hand as the card is clicked, not when
  // the card is held up. A turn beat holds nothing back either: it plays
  // first and at once, so the unlocks and the draw it announces may as well
  // slide under the banner.
  const beats: Beat[] = made.map(({ beat }) => ({ ...beat, reveals: NOTHING }));
  const held = made.map(() => ({ cards: new Set<CardInstanceId>(), cities: new Set<number>() }));
  events.forEach((event, index) => {
    const change = changes(event);
    if (!change) return;
    let owner = -1;
    made.forEach((entry, at) => {
      if (entry.anchor <= index && entry.beat.kind !== 'turn') owner = at;
    });
    const bucket = held[owner];
    if (!bucket) return;
    if (change.card !== undefined) bucket.cards.add(change.card);
    if (change.city !== undefined) bucket.cities.add(change.city);
  });
  held.forEach((bucket, at) => {
    const beat = beats[at];
    if (beat)
      beats[at] = { ...beat, reveals: { cards: [...bucket.cards], cities: [...bucket.cities] } };
  });

  // Let the board finish moving before anything is held up over it. Not when
  // a turn banner opens the batch — it covers the cards sliding under it —
  // and a phase caption alone is not something to hold the board for.
  const slides = events.some((event) => SLIDES.has(event.type));
  const first = beats[0];
  const speaks = beats.some((beat) => beat.kind !== 'phase');
  if (!(first && first.kind === 'turn')) {
    const settle = Math.max(slides ? BEAT_MS.SETTLE : 0, speaks ? BEAT_MS.BREATH : 0);
    if (settle > 0) beats.unshift({ kind: 'settle', ms: settle, reveals: NOTHING });
  }

  return beats;
}

/** How long a batch keeps the screen busy, from one seat's point of view. */
export const presentationMs = (events: readonly GameEvent[], viewer: PlayerId): number =>
  planBeats(events, viewer).reduce((total, beat) => total + beat.ms, 0);
