import {
  isCityHidden,
  isHidden,
  type GameAction,
  type PlayerId,
  type PlayerView,
  type ViewCard,
  type ViewCity,
} from '@berserk/engine';
import {
  useEffect,
  useState,
  type CSSProperties,
  type DragEvent,
  type JSX,
  type PointerEvent,
} from 'react';
import { CardImage, CITY_BACK, CITY_CAPITAL, CITY_FACE } from './CardImage.js';
import { CardMenu, type CardMenuItem } from './CardMenu.js';
import { BattleBar } from './BattleBar.js';
import { Nameplate, seatColour } from './Nameplate.js';
import { ZonePile } from './ZonePile.js';
import { useCardDrag, type CardDrag } from './useCardDrag.js';
import { useCardFlip } from './useCardFlip.js';
import { usePeek, type Peekable } from './usePeek.js';
import { useStatsKey } from './useStatsKey.js';
import { costOf, nameOf, statsOf, useCardNames } from '../state/useCardNames.js';

/**
 * The table.
 *
 * Laid out the way a card game is actually sat at: the five cities are the
 * halfway line, your side below and the opponent's above, mirrored through
 * that line. Each player has a deck at their outer right and a graveyard at
 * their outer left, their hand inboard of those, and their badge at the very
 * edge — so the opponent's corners are the reflection of yours, as they would
 * be across a table.
 *
 * Counts are absent until asked for. Holding left Control puts each number
 * over the pile it belongs to (`useStatsKey`).
 *
 * Cards are acted on directly rather than through a list of buttons. In hand,
 * a click is a look and setting is a drag onto the area — the only thing a
 * card in hand can do (Rules.md §7), so a menu for it was a menu with one
 * item. On the table, a right click opens the card's menu. Every route reads
 * the same legal actions the server sent, so none can offer a move the engine
 * would reject.
 *
 * Choosing something that needs an area (Set, Move) puts the board into
 * targeting: areas that would accept the card light up, the rest dim, and
 * Escape backs out.
 */

interface Targeting {
  readonly card: string;
  readonly kind: 'set' | 'move';
  readonly cities: readonly number[];
}

interface MenuState {
  readonly x: number;
  readonly y: number;
  /** The card it belongs to, so it can close if that card leaves. */
  readonly card: string;
  readonly title: string;
  readonly items: readonly CardMenuItem[];
}

interface BoardProps {
  readonly view: PlayerView;
  readonly onAction: (action: GameAction) => void;
  readonly onInspect: (defId: string) => void;
  /** Hold a card to raise it; null puts it back down. Local only. */
  readonly onPeek: (defId: string | null) => void;
  /** Look through a graveyard. */
  readonly onOpenGrave: (player: string) => void;
  /** Consider opening a Set Card — the player still has to pay for it. */
  readonly onConsiderOpen: (action: Extract<GameAction, { type: 'OPEN_CARD' }>) => void;
  /** Dim the table while a hand step is in front of it. */
  readonly dimmed?: boolean;
}

/** Areas this card could be sent to by the given action type. */
function citiesFor(view: PlayerView, cardId: string, kind: 'set' | 'move'): number[] {
  const type = kind === 'set' ? 'SET_CARD' : 'MOVE_CHARACTER';
  return view.legalActions
    .filter((action) => action.type === type && 'card' in action && action.card === cardId)
    .map((action) => (action as unknown as { city: number }).city);
}

export function Board({
  view,
  onAction,
  onInspect,
  onPeek,
  onOpenGrave,
  onConsiderOpen,
  dimmed = false,
}: BoardProps): JSX.Element {
  const [targeting, setTargeting] = useState<Targeting | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dragging, setDragging] = useState<Targeting | null>(null);
  // The hand rests below the screen edge and rises on approach, so the table
  // keeps the room. Hover lives in React rather than CSS alone because the
  // slide changes where the cards are, and the animator has to know.
  const [handOpen, setHandOpen] = useState(false);
  const remeasure = useCardFlip();
  // Holding Control shows the counts; on a touchscreen there is no Control, so
  // the player's own badge is a switch for the same thing.
  const [pinnedStats, setPinnedStats] = useState(false);
  const stats = useStatsKey() || pinnedStats;
  const peek = usePeek(onPeek);
  const touchDrag = useCardDrag({
    onDrag: setDragging,
    onDrop: (payload, city) => send(payload.card, payload.kind, city),
    onCancelPeek: peek.cancel,
  });
  useCardNames();

  // A tap outside the hand is what a finger has instead of leaving it, so the
  // hand does not sit open over the board for the rest of the game.
  useEffect(() => {
    if (!handOpen) return;
    const away = (event: globalThis.PointerEvent): void => {
      if (event.pointerType === 'mouse') return;
      const target = event.target;
      if (target instanceof Element && target.closest('.hand')) return;
      setHandOpen(false);
    };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, [handOpen]);

  // Escape backs out of targeting; the player should never feel trapped in it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setTargeting(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Targeting ends on any change from the server: what it was aiming at may
  // no longer be a legal destination, and the highlights would be lying.
  useEffect(() => {
    setTargeting(null);
  }, [view.version]);

  // The menu is not so fragile. It used to close on every update too, which
  // meant it could not be opened at all while the opponent was playing —
  // their moves arrive about once a second. Nothing is risked by leaving it
  // up: every item goes through the server, which re-checks it and rejects
  // anything that has gone stale. It closes when its card is gone.
  useEffect(() => {
    setMenu((open) => (open && view.cards[open.card] ? open : null));
  }, [view.version, view.cards]);

  const send = (cardId: string, kind: 'set' | 'move', city: number): void => {
    onAction(
      kind === 'set'
        ? { type: 'SET_CARD', card: cardId as never, city }
        : { type: 'MOVE_CHARACTER', card: cardId as never, city },
    );
    setTargeting(null);
    setDragging(null);
  };

  /**
   * The battle move this card is being offered for, if any: leading the
   * attack, or joining it. Rules.md §11 ①/③ — both are chosen on the card
   * itself, which is where the player is already looking.
   */
  const battleMoveFor = (instanceId: string): GameAction | undefined =>
    view.legalActions.find(
      (action) =>
        (action.type === 'DESIGNATE_VANGUARD' || action.type === 'COMMIT_CHARACTER') &&
        action.card === instanceId,
    );

  /** The open the engine is offering for this card, if any. */
  const openFor = (instanceId: string): Extract<GameAction, { type: 'OPEN_CARD' }> | undefined =>
    view.legalActions.find(
      (action): action is Extract<GameAction, { type: 'OPEN_CARD' }> =>
        action.type === 'OPEN_CARD' && action.card === instanceId,
    );

  /**
   * What clicking a card on the board does.
   *
   * A locked character has spent its turn and an opponent's card is not yours
   * to act on, so for both the only useful thing is a closer look — and
   * making the player go through a menu for that is a menu that always has
   * one item. Anything you *can* act on gets the menu instead.
   */
  const clickCard = (at: { clientX: number; clientY: number }, card: ViewCard): void => {
    const defId = 'defId' in card ? card.defId : null;
    const theirs = card.controller !== view.viewer;
    const locked = card.locked;

    if (defId && (theirs || locked)) {
      onInspect(defId);
      return;
    }
    openMenu(at, card);
  };

  const openMenu = (at: { clientX: number; clientY: number }, card: ViewCard): void => {
    const defId = 'defId' in card ? card.defId : null;
    const items: CardMenuItem[] = [];

    // Opening is the play, so it leads. Rules.md §10 ③ allows one a turn, and
    // the engine offers a card at most once — with a payment already worked
    // out from the hand — so there is nothing to choose here but whether.
    const open = openFor(card.instanceId);
    if (open) {
      const cost = defId ? costOf(defId) : null;
      items.push({
        label: 'Open',
        ...(cost ? { hint: `pay ${cost}` } : {}),
        onPick: () => onConsiderOpen(open),
      });
    }

    if (defId) items.push({ label: 'Inspect', onPick: () => onInspect(defId) });

    // Rules.md §10 ④(4) — declare from a city you do not occupy. The city is
    // the target, but the decision is made looking at the character that will
    // be leading, so it is offered here.
    if (card.zone === 'city' && card.controller === view.viewer && card.cityIndex !== undefined) {
      const attack = view.legalActions.find(
        (action) => action.type === 'DECLARE_BATTLE' && action.city === card.cityIndex,
      );
      if (attack) {
        items.push({
          label: 'Attack',
          hint: `area ${card.cityIndex + 1}`,
          onPick: () => onAction(attack),
        });
      }
    }

    for (const kind of ['set', 'move'] as const) {
      const cities = citiesFor(view, card.instanceId, kind);
      if (cities.length === 0) continue;
      items.push({
        label: kind === 'set' ? 'Set' : 'Move',
        hint: 'choose an area',
        onPick: () => setTargeting({ card: card.instanceId, kind, cities }),
      });
    }

    if (items.length === 0) return;
    setMenu({
      x: at.clientX,
      y: at.clientY,
      card: card.instanceId,
      title: defId ? nameOf(defId) : 'Face-down card',
      items,
    });
  };

  const opponentId = view.seats.find((seat) => seat !== view.viewer);
  const active = targeting ?? dragging;

  const classes = ['board'];
  if (dimmed) classes.push('board--dimmed');
  if (stats) classes.push('board--stats');

  return (
    <div className={classes.join(' ')}>
      {view.battle && <BattleBar view={view} battle={view.battle} onAction={onAction} />}
      <Nameplate view={view} player={opponentId} side="top" stats={stats} />
      <OpponentHand view={view} player={opponentId} stats={stats} />

      {/* Mirrored through the city line: their right is your left. */}
      <div className="corner corner--top-left">
        <ZonePile
          view={view}
          player={opponentId ?? ''}
          kind="deck"
          stats={stats}
          onOpen={() => opponentId && onOpenGrave(opponentId)}
        />
      </div>
      <div className="corner corner--top-right">
        <ZonePile
          view={view}
          player={opponentId ?? ''}
          kind="trash"
          stats={stats}
          onOpen={() => opponentId && onOpenGrave(opponentId)}
        />
      </div>

      <div className={active ? 'cities cities--targeting' : 'cities'}>
        {/* One plane, tilted as a whole. Tilting each column on its own would
            shear the outer ones away from the middle instead of laying the
            table back. */}
        <div className="cities__plane">
          {view.cities.map((city) => (
            <CityColumn
              key={city.index}
              city={city}
              view={view}
              opponent={opponentId}
              highlighted={active?.cities.includes(city.index) ?? false}
              targeting={active !== null}
              onPick={() => active && send(active.card, active.kind, city.index)}
              declare={view.legalActions.find(
                (action) => action.type === 'DECLARE_BATTLE' && action.city === city.index,
              )}
              onDeclare={onAction}
              onDropCard={(cardId, kind) => send(cardId, kind, city.index)}
              onCardMenu={openMenu}
              onClickCard={clickCard}
              onDragCard={setDragging}
              touchDrag={touchDrag}
              onOpenCard={onConsiderOpen}
              openFor={openFor}
              battleMoveFor={battleMoveFor}
              onBattleMove={onAction}
              peek={peek}
            />
          ))}
        </div>
      </div>

      {/* Out along the left edge, clear of the halfway line. */}
      <div className="phase-rail">
        <span className="phase-rail__turn">T{view.turn.turnNumber}</span>
        {view.phases.map((phase, index) => (
          <span
            key={phase.id}
            className={index === view.turn.phaseIndex ? 'phase phase--current' : 'phase'}
          >
            {phase.name}
          </span>
        ))}
        <span className="phase-rail__level">Lv{view.cityLevel}</span>
      </div>

      <div className="corner corner--bottom-left">
        <ZonePile
          view={view}
          player={view.viewer}
          kind="trash"
          stats={stats}
          onOpen={() => onOpenGrave(view.viewer)}
        />
      </div>
      <div className="corner corner--bottom-right">
        <ZonePile
          view={view}
          player={view.viewer}
          kind="deck"
          stats={stats}
          onOpen={() => onOpenGrave(view.viewer)}
        />
      </div>

      <Hand
        view={view}
        open={handOpen || dimmed}
        onOpen={setHandOpen}
        onSettled={remeasure}
        onInspect={onInspect}
        onDragCard={setDragging}
        touchDrag={touchDrag}
        stats={stats}
        peek={peek}
      />

      <Nameplate
        view={view}
        player={view.viewer}
        side="bottom"
        stats={stats}
        onToggleStats={() => setPinnedStats((on) => !on)}
      />

      {targeting && (
        <div className="targeting-bar">
          <span>Choose an area to {targeting.kind === 'set' ? 'set into' : 'move to'}</span>
          <button type="button" className="btn" onClick={() => setTargeting(null)}>
            Cancel
          </button>
        </div>
      )}

      {menu && (
        <CardMenu
          x={menu.x}
          y={menu.y}
          title={menu.title}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function CityColumn({
  city,
  view,
  opponent,
  highlighted,
  targeting,
  onPick,
  onDropCard,
  onCardMenu,
  onClickCard,
  onDragCard,
  touchDrag,
  onOpenCard,
  openFor,
  battleMoveFor,
  onBattleMove,
  declare,
  onDeclare,
  peek,
}: {
  city: ViewCity;
  view: PlayerView;
  opponent: PlayerId | undefined;
  highlighted: boolean;
  targeting: boolean;
  onPick: () => void;
  onDropCard: (cardId: string, kind: 'set' | 'move') => void;
  onCardMenu: (at: { clientX: number; clientY: number }, card: ViewCard) => void;
  onClickCard: (at: { clientX: number; clientY: number }, card: ViewCard) => void;
  onDragCard: (targeting: Targeting | null) => void;
  touchDrag: CardDrag;
  onOpenCard: (action: Extract<GameAction, { type: 'OPEN_CARD' }>) => void;
  openFor: (instanceId: string) => Extract<GameAction, { type: 'OPEN_CARD' }> | undefined;
  battleMoveFor: (instanceId: string) => GameAction | undefined;
  onBattleMove: (action: GameAction) => void;
  /** Set when this city can be attacked right now. Rules.md §10 ④(4). */
  declare?: GameAction | undefined;
  onDeclare: (action: GameAction) => void;
  peek: Peekable;
}): JSX.Element {
  const inCity = (player: PlayerId | undefined): ViewCard[] =>
    player === undefined
      ? []
      : Object.values(view.cards).filter(
          (card) =>
            card.zone === 'city' && card.cityIndex === city.index && card.controller === player,
        );

  const occupied = city.occupiedBy;
  // A face-down city says nothing at all, the way a face-down card doesn't.
  // Its name arrives with its face, when it is fought over. Rules.md §5.
  const label = isCityHidden(city) ? null : city.name;

  const classes = ['city', city.faceUp ? 'city--up' : 'city--down'];
  if (targeting) classes.push(highlighted ? 'city--target' : 'city--muted');
  if (declare && !targeting) classes.push('city--attackable');
  // A held city glows in its holder's colour, so who owns what is readable
  // from across the board without counting flags.
  if (occupied) classes.push('city--held', `nameplate--${seatColour(view, occupied)}`);
  // A city lies on its side until somebody holds it. Rules.md §5 — it is
  // being attacked that turns one face up, and winning there that claims it,
  // so standing upright is what "this one is somebody's" looks like.
  if (!city.faceUp || !occupied) classes.push('city--flat');

  // Without preventDefault the browser refuses to accept the drop.
  const accept = (event: DragEvent): void => {
    if (highlighted) event.preventDefault();
  };

  return (
    <div
      className={classes.join(' ')}
      data-city={city.index}
      onClick={highlighted ? onPick : declare ? () => onDeclare(declare) : undefined}
      onDragOver={accept}
      onDragEnter={accept}
      onDrop={(event) => {
        event.preventDefault();
        const [kind, cardId] = event.dataTransfer.getData('text/plain').split(':');
        if (highlighted && cardId && (kind === 'set' || kind === 'move')) onDropCard(cardId, kind);
      }}
    >
      <div className="city__lane">
        {inCity(opponent).map((card) => (
          <CardTile
            key={card.instanceId}
            card={card}
            onMenu={onCardMenu}
            onClickCard={onClickCard}
            peek={peek}
          />
        ))}
      </div>

      <div className="city__card">
        {/* Rules.md §5 — a face-down city draws the one back every city
         * shares, so the Royal Capital's position stays secret. Its own face
         * only goes up once the city has been fought over. */}
        <img
          className="city__art"
          src={isCityHidden(city) ? CITY_BACK : city.royalCapital ? CITY_CAPITAL : CITY_FACE}
          alt=""
          draggable={false}
        />
        {/* Wrapped so the face can turn with the card when it lies flat. */}
        {label !== null && (
          <span className="city__face">
            <span className="city__name">{label}</span>
            {occupied && (
              <span
                className={occupied === view.viewer ? 'city__flag city__flag--you' : 'city__flag'}
              >
                {occupied === view.viewer ? 'yours' : 'theirs'}
              </span>
            )}
          </span>
        )}
      </div>

      <div className="city__lane">
        {inCity(view.viewer).map((card) => (
          <CardTile
            key={card.instanceId}
            card={card}
            onMenu={onCardMenu}
            onClickCard={onClickCard}
            onDragCard={onDragCard}
            touchDrag={touchDrag}
            drag={dragPayload(view, card, 'move')}
            peek={peek}
            onOpen={(() => {
              // A battle asks first: leading it or joining it (Rules.md §11
              // ①/③) is chosen on the character itself.
              const move = battleMoveFor(card.instanceId);
              if (move) return () => onBattleMove(move);
              const open = openFor(card.instanceId);
              return open ? () => onOpenCard(open) : undefined;
            })()}
            marked={battleMoveFor(card.instanceId) ? 'battle' : undefined}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * How far a character's numbers have been moved from what is printed on it.
 *
 * Positive if anything is up, negative if anything is down, zero if it stands
 * as printed. The server sends the live numbers (`current`) precisely because
 * the client cannot work an ability out from the card database — so this is a
 * comparison, not a calculation.
 */
function statShift(card: ViewCard): number {
  if (isHidden(card) || !card.current) return 0;
  const printed = statsOf(card.defId);
  if (!printed) return 0;
  return card.current.power - printed.power + (card.current.hp - printed.hp);
}

/**
 * Opens something on hover for a mouse, and on a tap for a finger.
 *
 * The type has to be checked on every one of them. A tap is followed by
 * *compatibility* mouse events — the browser pretending a mouse was there so
 * that old pages keep working — and one of those is a `mouseleave` that
 * arrives right after the tap. Bound to `onMouseLeave`, it closed whatever
 * the tap had just opened.
 */
function hoverOrTap(set: (open: boolean | ((was: boolean) => boolean)) => void): {
  onPointerEnter: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave: (event: PointerEvent<HTMLElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
} {
  return {
    onPointerEnter: (event) => {
      if (event.pointerType === 'mouse') set(true);
    },
    onPointerLeave: (event) => {
      if (event.pointerType === 'mouse') set(false);
    },
    onPointerDown: (event) => {
      if (event.pointerType !== 'mouse') set((was) => !was);
    },
  };
}

/**
 * Joins two sets of pointer handlers so both run.
 *
 * A card is a tap, a press-and-hold and a drag all at once, and each of those
 * wants `onPointerDown`. Spreading one after the other would silently drop
 * whichever came first — which is exactly how the peek stopped working the
 * first time this was wired up.
 */
type PressHandler = ((event: PointerEvent<HTMLElement>) => void) | undefined;

function merged<A extends { onPointerDown?: PressHandler }>(
  first: A,
  second: { onPointerDown?: PressHandler },
): A {
  if (!second.onPointerDown) return first;
  return {
    ...first,
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      first.onPointerDown?.(event);
      second.onPointerDown?.(event);
    },
  };
}

/** What dragging this card would mean, or undefined if it cannot be dragged. */
function dragPayload(
  view: PlayerView,
  card: ViewCard,
  kind: 'set' | 'move',
): Targeting | undefined {
  if (isHidden(card)) return undefined;
  const cities = citiesFor(view, card.instanceId, kind);
  return cities.length > 0 ? { card: card.instanceId, kind, cities } : undefined;
}

/**
 * The opponent's hand: backs only, fanned the other way, tucked under their
 * badge.
 *
 * Drawn from the cards themselves rather than from the count, even though a
 * count is all it *shows*. The identities stay hidden either way — `view.ts`
 * redacts them — but each back carries its card's id, and that is what lets
 * the animator move a card from here onto the board when it is played.
 * Backs rendered from a number have no history, so a card played from one
 * would appear on the table out of nowhere.
 */
function OpponentHand({
  view,
  player,
  stats,
}: {
  view: PlayerView;
  player: PlayerId | undefined;
  stats: boolean;
}): JSX.Element | null {
  // Tucked away like your own hand, and out when asked for. Their count is
  // public — it is the one thing about a hand you can see across a table —
  // so reaching for it is the natural way to ask.
  const [open, setOpen] = useState(false);
  if (!player) return null;

  // Their hand order is not sent — only which cards are in it. Sorting by id
  // keeps the fan from reshuffling itself every time the view updates, which
  // would set the animator chasing cards that never moved.
  const cards = Object.values(view.cards)
    .filter((card) => card.zone === 'hand' && card.controller === player)
    .sort((a, b) => a.instanceId.localeCompare(b.instanceId));

  const count = cards.length;
  const middle = (count - 1) / 2;
  const spread = count > 1 ? Math.min(4.5, 22 / count) : 0;

  return (
    <div
      className={open ? 'ohand ohand--open' : 'ohand'}
      // Pointer events rather than mouse ones, because they say what the
      // pointer *is*. A tap makes the browser fire a compatibility
      // `mouseleave` a moment later, which shut this again the instant a
      // finger opened it — the tap and the phantom mouse were
      // indistinguishable until the type came with them.
      {...hoverOrTap(setOpen)}
    >
      <div className="ohand__fan">
        {cards.map((card, index) => {
          const offset = index - middle;
          return (
            <div
              key={card.instanceId}
              className="card card--hidden card--back"
              data-card-id={card.instanceId}
              data-card-zone="hand"
              style={
                {
                  '--rot': `${-offset * spread}deg`,
                  '--lift': `${-Math.abs(offset) * 3.5}px`,
                  zIndex: index,
                } as CSSProperties
              }
            />
          );
        })}
      </div>
      {/* Held-Control shows every count at once; reaching for their hand
       * asks about this one. */}
      {(stats || open) && <span className="ohand__count">{count}</span>}
    </div>
  );
}

/**
 * Your hand.
 *
 * A card in hand can only go one place — face-down into an area (Rules.md §7)
 * — so setting it is a drag onto the area rather than a menu whose one useful
 * item is "Set". That leaves the click free for the thing a player actually
 * wants from a card too small to read: a proper look at it.
 */
function Hand({
  view,
  open,
  onOpen,
  onSettled,
  onInspect,
  onDragCard,
  touchDrag,
  stats,
  peek,
}: {
  view: PlayerView;
  open: boolean;
  onOpen: (open: boolean) => void;
  onSettled: () => void;
  onInspect: (defId: string) => void;
  onDragCard: (targeting: Targeting | null) => void;
  touchDrag: CardDrag;
  stats: boolean;
  peek: Peekable;
}): JSX.Element {
  const cards = (view.zoneOrder[`${view.viewer}:hand`] ?? [])
    .map((id) => view.cards[id])
    .filter((card): card is ViewCard => card !== undefined);

  // Fan the cards around the middle of the hand: a small rotation each side of
  // centre, and a matching dip so the tops describe an arc rather than a step.
  const middle = (cards.length - 1) / 2;
  const spread = cards.length > 1 ? Math.min(4.5, 22 / cards.length) : 0;

  return (
    <div
      className={open ? 'hand hand--open' : 'hand'}
      // A finger cannot hover, so a tap raises the hand and a tap anywhere
      // else puts it back down (see Board). Without this the hand stayed
      // below the screen edge on a phone and the game was unplayable — you
      // could never reach your own cards.
      {...hoverOrTap((next) => onOpen(typeof next === 'function' ? next(open) : next))}
      // The slide takes time; once it stops, the cards are somewhere new.
      onTransitionEnd={onSettled}
    >
      <div className="hand__fan">
        {cards.map((card, index) => {
          const offset = index - middle;
          return (
            <CardTile
              key={card.instanceId}
              card={card}
              onClickCard={(_at, clicked) => {
                if ('defId' in clicked) onInspect(clicked.defId);
              }}
              onDragCard={onDragCard}
              touchDrag={touchDrag}
              drag={dragPayload(view, card, 'set')}
              fan={{ rotate: offset * spread, lift: Math.abs(offset) * 3.5, index }}
              peek={peek}
            />
          );
        })}
      </div>
      {stats && <span className="hand__count">{cards.length}</span>}
    </div>
  );
}

interface Fan {
  readonly rotate: number;
  readonly lift: number;
  readonly index: number;
}

function CardTile({
  card,
  onMenu,
  onClickCard,
  drag,
  onDragCard,
  touchDrag,
  fan,
  peek,
  onOpen,
  marked,
}: {
  card: ViewCard;
  /** A right click. Absent in hand, which has nothing to offer but a look. */
  onMenu?: ((at: { clientX: number; clientY: number }, card: ViewCard) => void) | undefined;
  /** A left click. Set for cards on the board; the hand has its own meaning. */
  onClickCard?: ((at: { clientX: number; clientY: number }, card: ViewCard) => void) | undefined;
  drag?: Targeting | undefined;
  onDragCard?: ((targeting: Targeting | null) => void) | undefined;
  /** Touch dragging, which HTML5 drag-and-drop does not do at all. */
  touchDrag?: CardDrag | undefined;
  fan?: Fan | undefined;
  peek: Peekable;
  /** Set when clicking this card does something: opening it, or joining a battle. */
  onOpen?: (() => void) | undefined;
  /** Why it is lit, when it is not an open. */
  marked?: 'battle' | undefined;
}): JSX.Element {
  // What the viewer is *allowed* to know and what is *face up on the table*
  // are different things, and conflating them is how a Set Card ends up
  // drawn face up to its own controller.
  //
  // Rules.md §7: a card is Set face-down and stays that way until it is
  // opened. Its controller may check it — which is holding it or Inspect —
  // but on the table it lies face-down for both players.
  //
  // Only in a city: a card in hand or trash also carries `faceUp: false`,
  // and neither is a Set Card.
  // A redacted card in a city is face-down by definition — `view.ts` only
  // hides a Set Card, never a face-up one — so `faceUp` is a question worth
  // asking only about a card whose identity came through.
  const setCard = !isHidden(card) && card.zone === 'city' && !card.faceUp;

  // A card that can be opened says so, and asks when clicked — the menu is
  // the long way round for something that is the whole point of the phase.
  const openable = Boolean(onOpen);

  // Rules.md §6 — a locked card is turned; DesignNotes 11 shows that as a tilt.
  const classes = ['card'];
  if (card.locked) classes.push('card--locked');
  // A character an ability has lifted glows, because the numbers that changed
  // are not printed anywhere the player can see on the table. Rules.md §13.
  const shifted = statShift(card);
  if (shifted > 0) classes.push('card--buffed');
  if (shifted < 0) classes.push('card--weakened');
  if (isHidden(card) || setCard) classes.push('card--hidden');
  if (drag) classes.push('card--grabbable');
  if (openable) classes.push(marked === 'battle' ? 'card--battle' : 'card--openable');

  // The animator matches cards across zones by id, and only moves the ones
  // whose zone actually changed — see `useCardFlip`.
  const tracking = {
    'data-card-id': card.instanceId,
    'data-card-zone': card.zone === 'city' ? `city:${card.cityIndex ?? '?'}` : card.zone,
    style: fan
      ? ({
          '--rot': `${fan.rotate}deg`,
          '--lift': `${fan.lift}px`,
          zIndex: fan.index,
        } as CSSProperties)
      : undefined,
  };

  const grab = touchDrag?.bind(drag) ?? {};

  const handlers = {
    onContextMenu: (event: { preventDefault: () => void; clientX: number; clientY: number }) => {
      // Held back either way: the browser's own menu over a card is never
      // what the player meant.
      event.preventDefault();
      onMenu?.(event, card);
    },
    onClick: (event: { clientX: number; clientY: number }) => {
      // A hold ends in a click, and that one is a look, not a decision.
      if (peek.consumed()) return;
      // Opening, or joining a battle, is what the card is lit for and takes
      // precedence; otherwise a click is the card's menu or a closer look.
      if (onOpen) {
        onOpen();
        return;
      }
      onClickCard?.(event, card);
    },
    draggable: Boolean(drag),
    onDragStart: (event: DragEvent) => {
      // Dragging is not holding still: whichever the player meant, it is
      // this one.
      peek.cancel();
      if (!drag) return;
      event.dataTransfer.setData('text/plain', `${drag.kind}:${drag.card}`);
      event.dataTransfer.effectAllowed = 'move';
      onDragCard?.(drag);
    },
    onDragEnd: () => onDragCard?.(null),
  };

  if (isHidden(card) || setCard) {
    // Your own Set Card still binds the hold: checking it is your right
    // (Rules.md §7), it just is not on show. An opponent's has no id to bind,
    // so holding it does nothing.
    const own = isHidden(card) ? null : card.defId;
    return (
      <div
        className={classes.join(' ')}
        aria-label={own ? `Your set card: ${nameOf(own)}` : 'Face-down card'}
        title={own ? nameOf(own) : undefined}
        {...tracking}
        {...handlers}
        {...merged(own ? peek.bind(own) : {}, grab)}
      />
    );
  }

  return (
    <div
      className={classes.join(' ')}
      title={nameOf(card.defId)}
      {...tracking}
      {...handlers}
      {...merged(peek.bind(card.defId), grab)}
    >
      <CardImage defId={card.defId} />
      {card.damage > 0 && <span className="card__damage">-{card.damage}</span>}
    </div>
  );
}
