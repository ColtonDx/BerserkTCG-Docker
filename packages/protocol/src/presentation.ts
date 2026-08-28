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

export type Beat =
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
  /** A battle declared: the city wakes. Rules.md §5, §11. */
  | {
      readonly kind: 'battle';
      readonly city: number;
      readonly attacker: PlayerId;
      readonly ms: number;
    }
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
  BATTLE: 1100,
  OPEN: 1700,
  /** An open that also reads out what it did needs longer. */
  OPEN_WITH_ABILITY: 2400,
  ABILITY: 1900,
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
]);

/**
 * Cuts a batch into the beats that show it, in the order the engine resolved
 * them, from the point of view of one seat.
 *
 * The seat matters in one place: phase banners are for your own turn only.
 * Everything else is shown to both players alike.
 */
export function planBeats(events: readonly GameEvent[], viewer: PlayerId): Beat[] {
  const beats: Beat[] = [];

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
  let strike: { hits: Hit[]; deaths: CardInstanceId[] } | null = null;
  const closeStrike = (): void => {
    if (!strike) return;
    const { hits, deaths } = strike;
    const ms =
      deaths.length > 0
        ? (hits.length > 0 ? BEAT_MS.DEATH_AFTER : 0) + BEAT_MS.DEATH_FADE
        : BEAT_MS.STRIKE;
    const combat = hits.some((hit) => hit.combat);
    beats.push({ kind: 'strike', hits, deaths, city: combat ? battleCity : null, ms });
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
        beats.push({
          kind: 'turn',
          player: event.player,
          turnNumber: event.turnNumber,
          phases,
          ms: BEAT_MS.TURN,
        });
        break;
      }

      case 'PHASE_CHANGED': {
        // Spoken for by the turn banner if one is in this batch before it.
        const announced = events.slice(0, index).some((earlier) => earlier.type === 'TURN_STARTED');
        if (announced || event.player !== viewer) break;
        const last = beats[beats.length - 1];
        if (last && last.kind === 'phase') {
          beats[beats.length - 1] = { ...last, phases: [...last.phases, event.phaseId] };
        } else {
          beats.push({
            kind: 'phase',
            player: event.player,
            phases: [event.phaseId],
            ms: BEAT_MS.PHASE,
          });
        }
        break;
      }

      case 'BATTLE_DECLARED':
        beats.push({
          kind: 'battle',
          city: event.city,
          attacker: event.attacker,
          ms: BEAT_MS.BATTLE,
        });
        break;

      case 'CARD_OPENED': {
        // The first ability this card fires in the batch rides with the open.
        const firedAt = events.findIndex(
          (later, at) =>
            at > index && later.type === 'ABILITY_RESOLVED' && later.card === event.card,
        );
        const fired = firedAt >= 0 ? events[firedAt] : undefined;
        if (firedAt >= 0) folded.add(firedAt);
        const ability = fired && fired.type === 'ABILITY_RESOLVED' ? fired.text : undefined;
        beats.push({
          kind: 'open',
          card: event.card,
          player: event.player,
          ...(ability !== undefined ? { ability } : {}),
          ...(ability !== undefined && fizzled.has(event.card) ? { fizzled: true } : {}),
          ms: ability === undefined ? BEAT_MS.OPEN : BEAT_MS.OPEN_WITH_ABILITY,
        });
        break;
      }

      case 'ABILITY_RESOLVED':
        if (folded.has(index)) break;
        beats.push({
          kind: 'ability',
          card: event.card,
          player: event.player,
          text: event.text,
          ...(fizzled.has(event.card) ? { fizzled: true } : {}),
          ms: BEAT_MS.ABILITY,
        });
        break;

      case 'DAMAGE_DEALT': {
        // A blow that lands while a death is already pending starts a new
        // beat: two strikes in a row are two moments, not one.
        if (strike && strike.deaths.length > 0) closeStrike();
        strike ??= { hits: [], deaths: [] };
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
        strike ??= { hits: [], deaths: [] };
        strike.deaths.push(event.card);
        break;

      case 'CITY_OCCUPIED':
        // A city falling vacant pays nobody and is not announced.
        if (event.player !== null) {
          beats.push({
            kind: 'cityTaken',
            city: event.city,
            player: event.player,
            ms: BEAT_MS.CITY_TAKEN,
          });
        }
        break;

      default:
        break;
    }
  });
  closeStrike();

  // Let the board finish moving before anything is held up over it. Not when
  // a turn banner opens the batch — it covers the cards sliding under it —
  // and a phase caption alone is not something to hold the board for.
  const slides = events.some((event) => SLIDES.has(event.type));
  const first = beats[0];
  const speaks = beats.some((beat) => beat.kind !== 'phase');
  if (!(first && first.kind === 'turn')) {
    const settle = Math.max(slides ? BEAT_MS.SETTLE : 0, speaks ? BEAT_MS.BREATH : 0);
    if (settle > 0) beats.unshift({ kind: 'settle', ms: settle });
  }

  return beats;
}

/** How long a batch keeps the screen busy, from one seat's point of view. */
export const presentationMs = (events: readonly GameEvent[], viewer: PlayerId): number =>
  planBeats(events, viewer).reduce((total, beat) => total + beat.ms, 0);
