import type { GameAction, GameEvent, PlayerId, PlayerView } from '@berserk/engine';
import { isCityHidden, isHidden } from '@berserk/engine';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react';
import { nameOf } from '../state/useCardNames.js';

/**
 * The coach: a guided first game. DesignNotes "Tutorial".
 *
 * The tutorial is an ordinary match against Femto dealt from a fixed seed
 * (`server/tutorial.ts`), so the player goes first and holds Mercenaries to
 * set. Nothing here changes the rules or moves a card: the coach reads the
 * view, says what the table is asking, and rings the thing to click. Every
 * step is a *predicate* on the view rather than a position in a script, so
 * a player who does things in another order — sets three cards, moves
 * before attacking — is met where they are rather than told they are wrong.
 *
 * Three kinds of step. A **lesson** applies once, in order, and is done when
 * the board shows it happened (or when the player clicks Next). A
 * **reaction** applies the first time something new turns up — a Quick
 * window, a card asking a question — wherever the lesson is. And on Femto's
 * turn every one of its moves is **narrated**: Femto acts, the coach says
 * what it did, the player reads it, Femto acts again — the server holds
 * Femto while anything is on screen (`tutorial:hold`), so that alternation
 * is strict.
 */

interface Step {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  /** Rules.md section, shown as a small reference. */
  readonly rule?: string;
  /** CSS selectors of what to ring, read off the view. */
  readonly spot?: (view: PlayerView, me: PlayerId) => readonly string[];
  /** The step is shown while this holds and it is not yet done. */
  readonly when: (view: PlayerView, me: PlayerId, paying: boolean) => boolean;
  /** The step is done when this holds. Absent: done by Next. */
  readonly done?: (view: PlayerView, me: PlayerId, paying: boolean) => boolean;
  /** A reaction rather than a lesson: fires once, whenever it first applies. */
  readonly reaction?: boolean;
}

const mine = (view: PlayerView, me: PlayerId) =>
  Object.values(view.cards).filter((card) => card.controller === me && card.zone === 'city');
const myTurn = (view: PlayerView, me: PlayerId): boolean =>
  view.status.kind === 'playing' && view.turn.activePlayer === me;
const phase = (view: PlayerView): string => view.phases[view.turn.phaseIndex]?.id ?? '';
const can = (view: PlayerView, type: GameAction['type']): boolean =>
  view.legalActions.some((action) => action.type === type);
const setCardsOf = (view: PlayerView, me: PlayerId) =>
  mine(view, me).filter((card) => !isHidden(card) && !card.faceUp);
const holds = (view: PlayerView, me: PlayerId): number =>
  view.cities.filter((city) => city.occupiedBy === me).length;

const STEPS: readonly Step[] = [
  {
    id: 'welcome',
    title: 'Welcome to the table',
    body: 'Five areas lie between you and Femto, each with a City card face down in the middle — one of them is the Royal Capital. You win by occupying three cities including the Capital, or when Femto cannot draw. Your cards are along the bottom; theirs along the top.',
    rule: '§1, §5',
    when: (view) => view.status.kind === 'setup',
  },
  {
    id: 'keep',
    title: 'Your opening hand',
    body: 'Seven cards. You could shuffle them back and draw one fewer, but this hand is worth keeping: the Mercenaries in it are Level 0, and Level 0 is the only thing you can open before any city is awake. Click Keep.',
    rule: '§9.4',
    spot: () => ['[data-tutorial="keep"]'],
    when: (view) => can(view, 'KEEP_HAND'),
    done: (view, me) => !view.mulliganPending.includes(me),
  },
  {
    id: 'firstSet',
    title: 'Set a card',
    body: 'You go first, so there is no draw and no open this turn — only setting. Drag a Mercenary from your hand into the middle area: it lies face down there, hidden from Femto, until you open it on a later turn.',
    rule: '§10 ④(2)',
    spot: (view, me) => [
      '.hand__fan',
      ...(view.zoneOrder[`${me}:hand`] ?? [])
        .filter((id) => {
          const card = view.cards[id];
          return card !== undefined && 'defId' in card && card.defId === 'BK1-001';
        })
        .map((id) => `[data-card-id="${id}"]`),
      '[data-city="2"]',
    ],
    when: (view, me) => myTurn(view, me) && view.turn.turnNumber === 1 && phase(view) === 'main',
    done: (view, me) => setCardsOf(view, me).length >= 1,
  },
  {
    id: 'secondSet',
    title: 'Set another',
    body: 'You may set as many cards as you like in a turn. Spread out — put a second Mercenary in a different area, so you have two claims to open over the coming turns. Cards in hand also pay for opens, so keep a couple back.',
    rule: '§10 ④(2), §7',
    spot: () => ['.hand__fan'],
    when: (view, me) => myTurn(view, me) && view.turn.turnNumber === 1 && phase(view) === 'main',
    done: (view, me) => setCardsOf(view, me).length >= 2,
  },
  {
    id: 'endTurn',
    title: 'End your turn',
    body: 'That is the first turn. Click Next to end it. In the End phase you must discard down to seven cards if you are over — you are not.',
    rule: '§10 ⑤',
    spot: () => ['.turn-button'],
    when: (view, me) => myTurn(view, me) && view.turn.turnNumber === 1 && phase(view) === 'main',
    done: (view, me) => !myTurn(view, me),
  },
  {
    id: 'open',
    title: 'The Open step',
    body: 'Your turn again: you drew a card, and now you may open one Set Card — just one per turn, the whole game turns on that. A Mercenary costs one white card from your hand. Click one of your set Mercenaries.',
    rule: '§10 ③, §7',
    spot: (view, me) =>
      view.legalActions
        .filter(
          (action): action is Extract<GameAction, { type: 'OPEN_CARD' }> =>
            action.type === 'OPEN_CARD',
        )
        .map((action) => `[data-card-id="${action.card}"]`),
    when: (view, me) => myTurn(view, me) && phase(view) === 'open' && can(view, 'OPEN_CARD'),
    done: (view, me) => view.turn.openedThisTurn || phase(view) !== 'open',
  },
  {
    id: 'pay',
    title: 'Pay the cost',
    body: 'Every open is paid from hand: the cost on the card, in colours. A W is any white card. Click the card you will spend, then confirm.',
    rule: '§7',
    when: (_view, _me, paying) => paying,
    // Done when the dialog has gone, whichever way.
    done: (_view, _me, paying) => !paying,
  },
  {
    id: 'attack',
    title: 'Declare battle',
    body: 'Main phase. Your character stands in an area; the city there is still face down. Attack it: click the area. Nobody defends an area with no one standing in it, so you take the city — and taking one turns it face up, which raises City Level for both players and unlocks higher-Level cards.',
    rule: '§10 ④(4), §5, §12',
    spot: (view) =>
      view.legalActions
        .filter(
          (action): action is Extract<GameAction, { type: 'DECLARE_BATTLE' }> =>
            action.type === 'DECLARE_BATTLE',
        )
        .map((action) => `[data-city="${action.city}"]`),
    when: (view, me) =>
      myTurn(view, me) &&
      phase(view) === 'main' &&
      view.battle === null &&
      can(view, 'DECLARE_BATTLE'),
    done: (view, me) => view.battle !== null || holds(view, me) > 0,
  },
  {
    id: 'vanguard',
    title: 'Name the vanguard',
    body: 'The character leading the attack. Click it: it locks — turned on its side — and the city turns face up. Until you name one you can still call the attack off for nothing.',
    rule: '§11 ①',
    spot: (view) =>
      view.legalActions
        .filter(
          (action): action is Extract<GameAction, { type: 'DESIGNATE_VANGUARD' }> =>
            action.type === 'DESIGNATE_VANGUARD',
        )
        .map((action) => `[data-card-id="${action.card}"]`),
    when: (view, me) => view.battle?.step === 'vanguard' && view.battle.waitingOn === me,
    done: (view) => view.battle === null || view.battle.step !== 'vanguard',
  },
  {
    id: 'opens',
    title: 'The combat open',
    body: 'Each side may open one Set Card in this area — the defender first — and it does not count against the one open per turn. Nothing to open here? Click Open nothing.',
    rule: '§11 ②',
    spot: () => ['.battlebar', '[data-tutorial="battle-pass"]'],
    when: (view, me) => view.battle?.step === 'opens' && view.battle.waitingOn === me,
    done: (view) => view.battle === null || view.battle.step !== 'opens',
  },
  {
    id: 'commit',
    title: 'Commit characters',
    body: 'Players take turns adding characters to the fight, one at a time, until both are done. A defender who occupies the city must commit everyone standing there. Click a character to add it, or Done.',
    rule: '§11 ③',
    spot: () => ['.battlebar'],
    when: (view, me) => view.battle?.step === 'commit' && view.battle.waitingOn === me,
    done: (view) => view.battle === null || view.battle.step !== 'commit',
  },
  {
    id: 'damage',
    title: 'Assign damage',
    body: 'The highest Range strikes first. A striker spends all of its Power among the enemies in the battle — click an enemy once per point. A character with damage equal to its HP is destroyed.',
    rule: '§11 ④',
    when: (view, me) =>
      view.battle?.step === 'damage' && view.battle.waitingOn === me && can(view, 'ASSIGN_DAMAGE'),
    done: (view) => view.battle === null || view.battle.step !== 'damage',
  },
  {
    id: 'taken',
    title: 'A city is yours',
    body: 'You occupy it, and the city pays you two cards. Hold three including the Royal Capital and you win. Femto will attack to take it back — and as the occupier, everyone you have standing there defends.',
    rule: '§12, §1',
    when: (view, me) => holds(view, me) > 0,
  },
  {
    id: 'loop',
    title: 'That is the whole loop',
    body: 'Draw, open one, then move, set and attack in your Main phase. Move a character by dragging it to an area within its Move. Right-click a character for its abilities. The coach will stay quiet now unless something new comes up. Good luck.',
    rule: '§10',
    when: (view, me) => holds(view, me) > 0,
  },

  // ---------------------------------------------------------------- reactions
  {
    id: 'quick',
    title: 'A Quick',
    body: 'Femto did something, and you hold a Quick that could answer it. A Quick can be opened out of turn, and one played in response resolves first. Play one from the strip below, or Pass.',
    rule: '§13, §14',
    spot: () => ['.quickbar'],
    when: (view, me) => view.quick?.waitingOn === me,
    reaction: true,
  },
  {
    id: 'pending',
    title: 'A card asks',
    body: 'An effect has stopped to ask you which cards — a discard, a search, a yes or no. Nothing else happens until you answer.',
    rule: '§13',
    when: (view, me) => view.pending?.waitingOn === me,
    reaction: true,
  },
  {
    id: 'capital',
    title: 'The Royal Capital',
    body: 'That city is the Royal Capital. The game cannot be won without it, so everything Femto does from here on will be about it — and so should everything you do.',
    rule: '§1',
    spot: (view) =>
      view.cities
        .filter((city) => !isCityHidden(city) && city.royalCapital)
        .map((city) => `[data-city="${city.index}"]`),
    when: (view) => view.cities.some((city) => !isCityHidden(city) && city.royalCapital),
    reaction: true,
  },
  {
    id: 'ability',
    title: 'An ability',
    body: `One of your characters has an ability it can use now — right-click it. "Tap:" abilities lock the character as their cost; others cost cards from hand.`,
    rule: '§13, §6',
    spot: (view) => [
      ...new Set(
        view.legalActions
          .filter(
            (action): action is Extract<GameAction, { type: 'USE_ABILITY' }> =>
              action.type === 'USE_ABILITY',
          )
          .map((action) => `[data-card-id="${action.card}"]`),
      ),
    ],
    when: (view) => can(view, 'USE_ABILITY') && view.quick === null,
    reaction: true,
  },
];

/**
 * What Femto just did, in the coach's words. DesignNotes "Tutorial".
 *
 * A batch is Femto's if it turned the table over to Femto (its turn began in
 * it) or if the first thing in it naming a player names Femto. The player's
 * own answers during Femto's turn — passing a window, committing a defender
 * — name the player, and are not narrated.
 */
function narrate(
  events: readonly GameEvent[],
  view: PlayerView,
  me: PlayerId,
): { title: string; body: string; rule?: string } | null {
  const them = view.seats.find((seat) => seat !== me);
  if (them === undefined) return null;
  const theirTurnBegan = events.some((e) => e.type === 'TURN_STARTED' && e.player === them);
  const actor = events
    .map((e) => ('player' in e ? e.player : 'attacker' in e ? e.attacker : null))
    .find((who) => who !== null);
  if (!theirTurnBegan && actor !== them) return null;

  const area = (index: number): string => {
    const city = view.cities[index];
    return city && !isCityHidden(city) ? city.name : `area ${index + 1}`;
  };
  const name = (id: string): string => {
    const card = view.cards[id];
    return card && !isHidden(card) ? nameOf(card.defId) : 'a card';
  };

  const lines: string[] = [];
  let rule: string | undefined;
  for (const event of events) {
    switch (event.type) {
      case 'TURN_STARTED':
        if (event.player === them) {
          lines.push(
            'Femto’s turn. Its Refresh phase unlocked everything it had locked, and its Draw phase gave it a card.',
          );
          rule = '§10 ①②';
        } else if (event.player === me) {
          lines.push('Femto has ended its turn. Yours begins the same way: Refresh, then Draw.');
          rule = '§10';
        }
        break;
      case 'CARD_SET':
        if (event.player !== them) break;
        lines.push(
          `Femto set a card face down in ${area(event.city)}. You cannot see what it is — a face-down card is a claim on that area, and a threat you may need to answer.`,
        );
        rule ??= '§10 ④(2)';
        break;
      case 'CARD_OPENED':
        if (event.player !== them) break;
        lines.push(
          `Femto opened ${name(event.card)} in ${area(event.city)}, paying its cost from hand. That was its one open for the turn.`,
        );
        rule ??= '§10 ③';
        break;
      case 'ABILITY_RESOLVED':
        if (event.player !== them) break;
        lines.push(`Its ability went off: “${event.text}”`);
        rule ??= '§13';
        break;
      case 'CHARACTER_MOVED': {
        const card = view.cards[event.card];
        if (card?.controller !== them) break;
        lines.push(
          `Femto moved ${name(event.card)} to ${area(event.to)}. Moving locks a character for the turn, so it cannot attack now.`,
        );
        rule ??= '§10 ④(1)';
        break;
      }
      case 'BATTLE_DECLARED':
        if (event.attacker !== them) break;
        lines.push(
          `Femto declared battle over ${area(event.city)}. You will be asked whether to open a Set Card there, then which characters defend.`,
        );
        rule ??= '§11';
        break;
      case 'VANGUARD_DESIGNATED': {
        const card = view.cards[event.card];
        if (card?.controller !== them) break;
        lines.push(
          `${name(event.card)} leads the attack as vanguard, and the city has turned face up.`,
        );
        rule ??= '§11 ①';
        break;
      }
      case 'CHARACTER_COMMITTED':
        if (event.player !== them) break;
        lines.push(`Femto committed ${name(event.card)} to the battle.`);
        rule ??= '§11 ③';
        break;
      case 'CITY_OCCUPIED':
        if (event.player === them) {
          lines.push(`Femto now occupies ${area(event.city)}, and drew two cards for it.`);
          rule ??= '§12';
        }
        break;
      case 'BATTLE_ENDED':
        if (event.result === 'stalemate') lines.push('The battle was called off.');
        else if (event.result === 'repel') lines.push('The attack was repelled.');
        else if (event.result === 'mutual_destruction') {
          lines.push('Both sides fell: the city stands empty.');
        }
        break;
      case 'QUICK_DECLINED':
        if (event.player === them) lines.push('Femto passed on playing a Quick.');
        break;
      case 'DAMAGE_DEALT':
        lines.push(`${name(event.target)} took ${event.amount} damage.`);
        rule ??= '§11 ④';
        break;
      case 'CHARACTER_DESTROYED':
        lines.push(`${name(event.card)} was destroyed.`);
        break;
      default:
        break;
    }
  }
  if (lines.length === 0) return null;
  return {
    title: theirTurnBegan ? 'Femto’s turn' : 'Femto acts',
    body: lines.join(' '),
    ...(rule !== undefined ? { rule } : {}),
  };
}

interface Props {
  readonly view: PlayerView;
  /** The last batch of events, to narrate Femto's moves from. */
  readonly events: readonly GameEvent[];
  /** The payment dialog is up: a lesson about paying applies. */
  readonly paying: boolean;
  /** Something is being shown; the coach waits for it. */
  readonly busy: boolean;
  /**
   * A step is on screen (true) or has been read (false). Femto does nothing
   * while it is true — the table must not move under an explanation.
   */
  readonly onHold: (hold: boolean) => void;
  readonly onQuit: () => void;
}

export function Tutorial({
  view,
  events,
  paying,
  busy,
  onHold,
  onQuit,
}: Props): JSX.Element | null {
  const me = view.viewer;
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const [quit, setQuit] = useState(false);
  // Batches already narrated and read, by identity.
  const narrated = useRef(new WeakSet<readonly GameEvent[]>());
  const [, bump] = useState(0);

  // What Femto just did comes first; then a reaction that has just become
  // true for the first time; then the first lesson not yet done whose
  // condition holds.
  const current = useMemo((): Step | null => {
    if (quit) return null;
    if (events.length > 0 && !narrated.current.has(events)) {
      const story = narrate(events, view, me);
      if (story) {
        return {
          id: 'narration',
          title: story.title,
          body: story.body,
          ...(story.rule !== undefined ? { rule: story.rule } : {}),
          when: () => true,
          reaction: true,
        };
      }
    }
    const reaction = STEPS.find(
      (step) => step.reaction && !done.has(step.id) && step.when(view, me, paying),
    );
    if (reaction) return reaction;
    return (
      STEPS.find((step) => !step.reaction && !done.has(step.id) && step.when(view, me, paying)) ??
      null
    );
  }, [view, events, me, paying, done, quit]);

  /** Read: a narration is put behind us by batch, a step by id. */
  const dismiss = (): void => {
    if (!current) return;
    if (current.id === 'narration') {
      narrated.current.add(events);
      bump((n) => n + 1);
      return;
    }
    setDone((now) => new Set([...now, current.id]));
  };

  // While a step is up, Femto waits. Released when it is read or done, and
  // when the coach goes away for good.
  useEffect(() => {
    onHold(current !== null);
  }, [current, onHold]);
  useEffect(() => () => onHold(false), [onHold]);

  // Lessons finish themselves when the board shows they happened.
  useEffect(() => {
    if (!current?.done) return;
    if (current.done(view, me, paying)) setDone((now) => new Set([...now, current.id]));
  }, [current, view, me, paying]);

  // Where to ring. Measured after each render and on resize, so the rings
  // follow the hand rising and the board reflowing.
  const [rings, setRings] = useState<readonly { x: number; y: number; w: number; h: number }[]>([]);
  useEffect(() => {
    const measure = (): void => {
      if (!current?.spot) {
        setRings([]);
        return;
      }
      const boxes: { x: number; y: number; w: number; h: number }[] = [];
      for (const selector of current.spot(view, me)) {
        for (const node of document.querySelectorAll<HTMLElement>(selector)) {
          const box = node.getBoundingClientRect();
          if (box.width === 0 && box.height === 0) continue;
          boxes.push({ x: box.left, y: box.top, w: box.width, h: box.height });
        }
      }
      setRings(boxes);
    };
    measure();
    const timer = window.setInterval(measure, 400);
    window.addEventListener('resize', measure);
    return () => {
      clearInterval(timer);
      window.removeEventListener('resize', measure);
    };
  }, [current, view, me]);

  if (!current || busy) return null;

  const index = STEPS.filter((step) => !step.reaction).findIndex((step) => step.id === current.id);
  const total = STEPS.filter((step) => !step.reaction).length;
  return (
    <>
      <div className="coach__rings" aria-hidden="true">
        {rings.map((ring, i) => (
          <span
            key={i}
            className="coach__ring"
            style={
              {
                left: `${ring.x - 6}px`,
                top: `${ring.y - 6}px`,
                width: `${ring.w + 12}px`,
                height: `${ring.h + 12}px`,
              } as CSSProperties
            }
          />
        ))}
      </div>

      <aside className={current.reaction ? 'coach coach--reaction' : 'coach'} role="complementary">
        <div className="coach__head">
          <span className="coach__kicker">
            {current.id === 'narration'
              ? 'Femto'
              : current.reaction
                ? 'Something new'
                : `Tutorial · ${index + 1} of ${total}`}
          </span>
          {current.rule && <span className="coach__rule">Rules {current.rule}</span>}
        </div>
        <h2 className="coach__title">{current.title}</h2>
        <p className="coach__body">{current.body}</p>
        <div className="coach__actions">
          {/* Every step can be read and dismissed; one with something to do
           * on the table finishes itself when that happens. Femto waits for
           * either. */}
          <button type="button" className="btn btn--primary" onClick={dismiss}>
            {current.id === 'narration'
              ? 'Next'
              : current.reaction
                ? 'Got it'
                : current.done
                  ? 'Got it — I’ll do it'
                  : 'Next'}
          </button>
          {current.done && !current.reaction && (
            <span className="coach__wait">or do it on the table</span>
          )}
          <button
            type="button"
            className="coach__quit"
            onClick={() => {
              setQuit(true);
              onQuit();
            }}
          >
            Skip tutorial
          </button>
        </div>
      </aside>
    </>
  );
}
