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
import { waitingOn } from './waitingOn.js';
import { BoostLinks, type BoostLink } from './BoostLinks.js';
import { Nameplate, seatColour } from './Nameplate.js';
import { ZonePile } from './ZonePile.js';
import { useCardDrag, type CardDrag } from './useCardDrag.js';
import { useCardFlip } from './useCardFlip.js';
import { usePeek, type Peekable } from './usePeek.js';
import { useStatsKey } from './useStatsKey.js';
import {
  abilityOf,
  costOf,
  nameOf,
  statsOf,
  useCardNames,
  type CardAbility,
} from '../state/useCardNames.js';

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
 * item. Every route reads the same legal actions the server sent, so none can
 * offer a move the engine would reject.
 *
 * On the table a left click is *also* only a look, and everything that commits
 * something is a deliberate gesture: a right click for the card's menu, a drag
 * onto an area to move, and a drag onto the area it already stands in to
 * attack there. A card that is lit — openable, or being asked to join a battle
 * — answers a click with that, because it is the whole point of the moment.
 *
 * That division is load-bearing. A left click used to open the menu, which put
 * "Attack" a careless click from a character standing anywhere attackable, and
 * the same click reached the city underneath and declared the battle outright.
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
  /**
   * Consider using a cost-bearing ability. Rules.md §13 — the same shape as
   * opening: settle the price, then point it at somebody if it asks.
   */
  readonly onUseAbility: (action: Extract<GameAction, { type: 'USE_ABILITY' }>) => void;
  /**
   * A paid-for card waiting to be pointed at somebody. Rules.md §13 — while
   * this is set the board is a target picker: the legal ones light up, the
   * rest go quiet, and nothing else on a card can be clicked.
   */
  readonly aiming?: { readonly source: string; readonly options: readonly string[] } | null;
  /** The target under the pointer, so the arrow can snap to it. */
  readonly onAimHover?: (card: string | null) => void;
  readonly onAimAt?: (card: string) => void;
  /** Dim the table while a hand step is in front of it. */
  readonly dimmed?: boolean;
  /** Something is still being shown; the battle bar holds its question. */
  readonly busy?: boolean;
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
  onUseAbility,
  aiming = null,
  onAimHover,
  onAimAt,
  dimmed = false,
  busy = false,
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
  // The card under the pointer, which is what the boost lines are drawn from.
  const [hovered, setHovered] = useState<string | null>(null);
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
    // Dropped on the area it is already standing in: that cannot be a move,
    // so it is the attack `dragPayload` offered it for. Rules.md §10 ④(4).
    const dropped = view.cards[cardId];
    const attack =
      kind === 'move' && dropped?.cityIndex === city
        ? view.legalActions.find(
            (action) => action.type === 'DECLARE_BATTLE' && action.city === city,
          )
        : undefined;

    onAction(
      attack ??
        (kind === 'set'
          ? { type: 'SET_CARD', card: cardId as never, city }
          : { type: 'MOVE_CHARACTER', card: cardId as never, city }),
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
   * What clicking a card on the board does: show it to you, and nothing else.
   *
   * A left click is a *look*. It used to open the card's menu, which put
   * "Attack" one careless click away from a character standing in a city that
   * could be attacked — and because the click also reached the city
   * underneath, simply clicking a character could declare a battle outright.
   * Moves that commit something are deliberate now: the menu is a right
   * click, and attacking is that or dragging the character onto its city.
   *
   * A face-down card the viewer may not identify has nothing to show, so it
   * does nothing at all rather than opening an empty inspector.
   */
  const clickCard = (_at: { clientX: number; clientY: number }, card: ViewCard): void => {
    const defId = 'defId' in card ? card.defId : null;
    if (defId) onInspect(defId);
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

    // Rules.md §13's cost-bearing abilities. `legalActions` names one by its
    // index on the card and offers one action per legal target, so they are
    // grouped back up here: one menu entry per ability, however many people
    // it could be pointed at. `canActivate` has already settled the timing and
    // whether the price can be met, so anything listed is usable now.
    if (defId) {
      const used = new Set<string>();
      for (const action of view.legalActions) {
        if (action.type !== 'USE_ABILITY' || action.card !== card.instanceId) continue;
        if (used.has(action.ability)) continue;
        used.add(action.ability);
        const printed = abilityOf(defId, action.ability);
        items.push({
          label: used.size > 1 ? `Use ability ${used.size}` : 'Use ability',
          hint: abilityPrice(printed),
          onPick: () => onUseAbility(action),
        });
      }
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
  // Rules.md §13 — while a card is being pointed, the board is a target
  // picker and everything that is not a candidate steps back.
  if (aiming) classes.push('board--aiming');

  /**
   * What a card is, to the target picker.
   *
   * `target` is anything it may be pointed at, `source` the card doing the
   * pointing, and everything else is out of it. Absent entirely when nothing
   * is being aimed, so the ordinary board is untouched.
   *
   * Being a candidate is asked *first*, because a character opened into an
   * area it is the only occupant of is a legal target for its own ability —
   * "target 1 character in this area" means itself (Rules.md §13). Reading
   * source before candidate would light that card as the pointer and leave
   * the player unable to click the only choice they have.
   */
  const aimRole = (instanceId: string): 'source' | 'target' | 'muted' | undefined => {
    if (!aiming) return undefined;
    if (aiming.options.includes(instanceId)) return 'target';
    return aiming.source === instanceId ? 'source' : 'muted';
  };

  /**
   * Whether this card is the one doing the pointing — asked separately from
   * the role above, because a card that may target itself answers `'target'`
   * there and is still the source. A face-down Set Card is turned up while it
   * is pointing (§7 lets its controller check it anyway), and reading the role
   * alone left the self-targeting case as a grey rectangle asking to be
   * chosen.
   */
  const isAimSource = (instanceId: string): boolean => aiming?.source === instanceId;

  // Both directions from whatever is under the pointer: what is lifting this
  // card, and what this card is lifting. Rules.md §13 — a continuous ability
  // reaches out from its own card, so a player hovering the *source* is asking
  // the same question as one hovering a boosted character. Not drawn while a
  // target is being chosen: there is already an arrow on screen, and adding
  // more lines to it would only confuse which one is the question.
  const links: BoostLink[] = [];
  if (hovered && !aiming) {
    for (const card of Object.values(view.cards)) {
      if (isHidden(card) || !card.boostedBy) continue;
      for (const source of card.boostedBy) {
        if (card.instanceId === hovered || source === hovered) {
          links.push({ from: source, to: card.instanceId });
        }
      }
    }
  }

  return (
    <div className={classes.join(' ')}>
      {view.battle && (
        <BattleBar view={view} battle={view.battle} onAction={onAction} busy={busy} />
      )}
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
              aimRole={aimRole}
              isAimSource={isAimSource}
              onHover={setHovered}
              {...(onAimAt ? { onAimAt } : {})}
              {...(onAimHover ? { onAimHover } : {})}
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

      {links.length > 0 && <BoostLinks links={links} version={view.version} />}

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
  aimRole,
  isAimSource,
  onHover,
  onAimAt,
  onAimHover,
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
  aimRole: (instanceId: string) => 'source' | 'target' | 'muted' | undefined;
  /** Separate from the role: a card may point at itself. Rules.md §13. */
  isAimSource: (instanceId: string) => boolean;
  /** The card under the pointer, for the boost lines. Rules.md §13. */
  onHover: (card: string | null) => void;
  onAimAt?: ((card: string) => void) | undefined;
  onAimHover?: ((card: string | null) => void) | undefined;
}): JSX.Element {
  // Attachments follow their host in the lane, tucked behind it — a Sylph
  // Sword is drawn on the character wearing it, not as a stranger beside.
  const inCity = (player: PlayerId | undefined): ViewCard[] => {
    if (player === undefined) return [];
    const here = Object.values(view.cards).filter(
      (card) => card.zone === 'city' && card.cityIndex === city.index && card.controller === player,
    );
    const hosts = here.filter((card) => wornBy(card) === undefined);
    return hosts.flatMap((host) => [
      host,
      ...here.filter((card) => wornBy(card) === host.instanceId),
    ]);
  };

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
  // A card standing here has made this a Demon City (BK3-043), which the
  // board shows as a red glow — the ground itself has changed, so it reads
  // off the city rather than off the card that did it.
  if (city.demonic) classes.push('city--demonic');

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
            aim={aimRole(card.instanceId)}
            aimSource={isAimSource(card.instanceId)}
            onHover={onHover}
            {...(onAimAt ? { onAimAt } : {})}
            {...(onAimHover ? { onAimHover } : {})}
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
            aim={aimRole(card.instanceId)}
            aimSource={isAimSource(card.instanceId)}
            onHover={onHover}
            {...(onAimAt ? { onAimAt } : {})}
            {...(onAimHover ? { onAimHover } : {})}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * How far a character's numbers have been moved from what is printed on it.
 *
 * The server sends the live numbers (`current`) precisely because the client
 * cannot work an ability out from the card database — so this is a comparison,
 * not a calculation. Null when there is nothing to compare: a face-down card,
 * a card in hand, anything that is not a character.
 */
interface StatDelta {
  readonly power: number;
  readonly hp: number;
  readonly move: number;
}

function statDelta(card: ViewCard): StatDelta | null {
  if (isHidden(card) || !card.current) return null;
  const printed = statsOf(card.defId);
  if (!printed) return null;
  return {
    power: card.current.power - printed.power,
    hp: card.current.hp - printed.hp,
    move: card.current.move - printed.move,
  };
}

/** Positive if anything is up, negative if down, zero if it stands as printed. */
function statShift(card: ViewCard): number {
  const delta = statDelta(card);
  if (!delta) return 0;
  return delta.power + delta.hp + delta.move;
}

const signed = (value: number): string => (value >= 0 ? `+${value}` : String(value));

/**
 * What using an ability will cost, in a few characters. Rules.md §13 and §6.
 *
 * Both kinds show, because they are paid from different places and a player
 * deciding needs to know which: cards leave the hand, a "Tap" locks the card
 * where it stands.
 */
function abilityPrice(ability: CardAbility | null): string {
  if (!ability) return '';
  const parts: string[] = [];
  if (ability.cost) parts.push(`pay ${ability.cost}`);
  if (ability.lockSelf) parts.push('lock it');
  if (ability.quick) parts.push('quick');
  return parts.join(' · ');
}

/**
 * The marker a lifted character wears. Rules.md §13.
 *
 * Written the way the numbers are printed — Power over HP — so `+1/+0` reads
 * off the card without a legend, with Move on its own when it has moved,
 * because a Move bonus is a different kind of thing from a fighting one and
 * folding it into the same pair would read as a third stat nobody has.
 *
 * Empty string when nothing has changed, so the badge is simply absent rather
 * than sitting there saying `+0/+0` on every character on the board.
 */
function boostLabel(delta: StatDelta | null): string {
  if (!delta) return '';
  const parts: string[] = [];
  if (delta.power !== 0 || delta.hp !== 0) {
    parts.push(`${signed(delta.power)}/${signed(delta.hp)}`);
  }
  if (delta.move !== 0) parts.push(`⇢${signed(delta.move)}`);
  return parts.join(' ');
}

/** The same thing spelled out, for a tooltip and for a screen reader. */
function boostTitle(delta: StatDelta): string {
  const parts: string[] = [];
  if (delta.power !== 0) parts.push(`${signed(delta.power)} Power`);
  if (delta.hp !== 0) parts.push(`${signed(delta.hp)} HP`);
  if (delta.move !== 0) parts.push(`${signed(delta.move)} Move`);
  return parts.join(', ');
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
 * Joins sets of pointer handlers so all of them run.
 *
 * A card is a tap, a press-and-hold, a drag and a hover all at once, and
 * several of those want the same event: `onPointerDown` is the peek and the
 * touch drag, `onPointerLeave` is the peek and the highlight that follows the
 * pointer. Spreading one set after another silently drops whichever came
 * first — which is exactly how the peek stopped working the first time this
 * was wired up, and how leaving a card stopped clearing the target it had
 * snapped the arrow to.
 */
type PointerHandler = (event: PointerEvent<HTMLElement>) => void;
type PointerProps = Partial<Record<string, PointerHandler | undefined>>;

function joinPointer(...sets: readonly PointerProps[]): PointerProps {
  const out: Record<string, PointerHandler> = {};
  for (const set of sets) {
    for (const [name, handler] of Object.entries(set)) {
      if (!handler) continue;
      const before = out[name];
      out[name] = before
        ? (event) => {
            before(event);
            handler(event);
          }
        : handler;
    }
  }
  return out;
}

/**
 * What dragging this card would mean, or undefined if it cannot be dragged.
 *
 * A character's own area is added to the destinations when a battle can be
 * declared there (Rules.md §10 ④(4)). Nothing else could ever be meant by
 * dragging a character onto the city it is already standing in — a move needs
 * somewhere else to go — so the gesture is free, and it gives attacking a
 * deliberate drag to sit beside the right-click menu.
 */
function dragPayload(
  view: PlayerView,
  card: ViewCard,
  kind: 'set' | 'move',
): Targeting | undefined {
  if (isHidden(card)) return undefined;
  const cities = citiesFor(view, card.instanceId, kind);

  const here = card.cityIndex;
  const canAttackHere =
    kind === 'move' &&
    here !== undefined &&
    card.zone === 'city' &&
    view.legalActions.some((action) => action.type === 'DECLARE_BATTLE' && action.city === here);

  const all = canAttackHere && here !== undefined ? [...cities, here] : cities;
  return all.length > 0 ? { card: card.instanceId, kind, cities: all } : undefined;
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

  // Lit on their side too, so "waiting for them" is visible rather than
  // inferred from nothing happening. Same signal, same rule, both ends of the
  // table — a glow that only ever appeared on your own hand would leave the
  // opponent's thinking indistinguishable from a stalled game.
  const theirs = waitingOn(view) === player;
  const classes = ['ohand'];
  if (open) classes.push('ohand--open');
  if (theirs) classes.push('ohand--live');

  return (
    <div
      className={classes.join(' ')}
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

  // Lit while the game is waiting on you. The hand is where a turn is spent,
  // so it is the natural place to say "you", and it answers the question a
  // player asks most often in a game that can hand the decision to the
  // non-turn player — see `waitingOn`.
  const yours = waitingOn(view) === view.viewer;
  const classes = ['hand'];
  if (open) classes.push('hand--open');
  if (yours) classes.push('hand--live');

  return (
    <div
      className={classes.join(' ')}
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
  aim,
  aimSource,
  onAimAt,
  onAimHover,
  onHover,
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
  /** What this card is to a target picker, if one is running. Rules.md §13. */
  aim?: 'source' | 'target' | 'muted' | undefined;
  /**
   * Whether this card is the one doing the pointing, which `aim` alone cannot
   * say: a character that is a legal target for its own ability is reported as
   * `'target'` so it stays clickable, and would otherwise stop being treated
   * as the source. Rules.md §13 — "target 1 character in this area" means
   * itself when it is the only one standing there.
   */
  aimSource?: boolean | undefined;
  onAimAt?: ((card: string) => void) | undefined;
  onAimHover?: ((card: string | null) => void) | undefined;
  /** Under the pointer, so the board can draw who is boosting whom. §13. */
  onHover?: ((card: string | null) => void) | undefined;
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
  const rawSetCard = !isHidden(card) && card.zone === 'city' && !card.faceUp;

  // The one deliberate exception, and it is not a leak.
  //
  // While this card is the one being pointed (Rules.md §13) its controller has
  // already chosen it and paid its cost — the open is happening, and the only
  // thing still outstanding is who it lands on. Leaving it face-down through
  // that meant choosing a victim for a grey rectangle. It is shown only to the
  // controller, who may check their own Set Cards anyway (§7, and the
  // press-and-hold already does exactly this), and only for the moment the
  // question is on screen.
  // Asked of `aimSource` rather than of `aim`, because a card that can point
  // at itself is reported as a *target* so it stays clickable — and reading
  // the role alone left exactly that card face-down while being asked to
  // choose it. That is the case this exists for: choosing a victim for a grey
  // rectangle is worst when the rectangle is the card that just opened.
  const revealing = aimSource === true && !isHidden(card);
  const setCard = rawSetCard && !revealing;

  // A card that can be opened says so, and asks when clicked — the menu is
  // the long way round for something that is the whole point of the phase.
  const openable = Boolean(onOpen);

  // Rules.md §6 — a locked card is turned; DesignNotes 11 shows that as a tilt.
  const classes = ['card'];
  if (card.locked) classes.push('card--locked');
  // Worn by another character (Rules.md §13): smaller, and behind it.
  if (wornBy(card) !== undefined) classes.push('card--attached');
  // A character an ability has lifted glows *and says by how much*, because
  // the numbers that changed are not printed anywhere the player can see on
  // the table — the art still shows what it was printed with. Rules.md §13.
  // The glow says something is happening; the marker says what.
  const delta = statDelta(card);
  const shifted = statShift(card);
  const boost = boostLabel(delta);
  if (shifted > 0) classes.push('card--buffed');
  if (shifted < 0) classes.push('card--weakened');
  if (isHidden(card) || setCard) classes.push('card--hidden');
  if (drag) classes.push('card--grabbable');
  if (openable) classes.push(marked === 'battle' ? 'card--battle' : 'card--openable');
  // A target picker overrides the ordinary lighting: while one is running the
  // only question on the table is who this card is being pointed at.
  if (aim) classes.push(`card--aim-${aim}`);
  // Turning face up as the question is asked, so the sequence reads as the
  // card opening and *then* wanting a target.
  if (revealing && rawSetCard) classes.push('card--revealing');

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

  /**
   * What the pointer resting here means: the arrow snaps to a candidate while
   * a target is being chosen (Rules.md §13), and otherwise the board draws the
   * abilities running into and out of this card.
   *
   * Mouse only for the boost lines. A finger has no hover, and the
   * compatibility mouse events a tap sends would leave lines drawn across a
   * board with nothing under the pointer to explain them — a touchscreen reads
   * the same thing off the card's own numbers and the inspector.
   */
  const hoverHandlers = {
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      if (aim === 'target') onAimHover?.(card.instanceId);
      if (event.pointerType === 'mouse') onHover?.(card.instanceId);
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => {
      if (aim === 'target') onAimHover?.(null);
      if (event.pointerType === 'mouse') onHover?.(null);
    },
  };

  const handlers = {
    onContextMenu: (event: { preventDefault: () => void; clientX: number; clientY: number }) => {
      // Held back either way: the browser's own menu over a card is never
      // what the player meant.
      event.preventDefault();
      // Nothing has a menu while a target is being chosen — the only thing
      // the board is asking is who.
      if (aim) return;
      onMenu?.(event, card);
    },
    onClick: (event: { clientX: number; clientY: number; stopPropagation: () => void }) => {
      // The city underneath is itself a button — clicking it declares a
      // battle there (Rules.md §10 ④(4)). A click that landed on a character
      // was aimed at the character, so it stops here rather than running on
      // and starting a fight the player never asked for.
      event.stopPropagation();
      // A hold ends in a click, and that one is a look, not a decision.
      if (peek.consumed()) return;
      // A running target picker owns every click on the table: landing the
      // choice on a candidate, and doing nothing at all anywhere else.
      if (aim) {
        if (aim === 'target') onAimAt?.(card.instanceId);
        return;
      }
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
        {...joinPointer(own ? peek.bind(own) : {}, grab, hoverHandlers)}
      />
    );
  }

  return (
    <div
      className={classes.join(' ')}
      title={nameOf(card.defId)}
      {...tracking}
      {...handlers}
      {...joinPointer(peek.bind(card.defId), grab, hoverHandlers)}
    >
      <CardImage defId={card.defId} />
      {card.damage > 0 && <span className="card__damage">-{card.damage}</span>}
      {boost && delta && (
        <span
          className={shifted > 0 ? 'card__boost card__boost--up' : 'card__boost card__boost--down'}
          title={boostTitle(delta)}
          aria-label={boostTitle(delta)}
        >
          {boost}
        </span>
      )}
    </div>
  );
}

/** The host this card is attached to, if it is an attachment. Rules.md §13. */
const wornBy = (card: ViewCard): string | undefined =>
  'attachedTo' in card ? card.attachedTo : undefined;
