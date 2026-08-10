import {
  isCityHidden,
  type CardInstanceId,
  type GameAction,
  type GameEvent,
  type PlayerView,
} from '@berserk/engine';
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { GameMenu } from './components/GameMenu.js';
import { MatchOver } from './components/MatchOver.js';
import { TurnButton } from './components/TurnButton.js';
import { Aim } from './components/Aim.js';
import { AssignDamage } from './components/AssignDamage.js';
import { Banner } from './components/Banner.js';
import { Board } from './components/Board.js';
import { BoardFx } from './components/BoardFx.js';
import { CityTaken, type Taken } from './components/CityTaken.js';
import { CoinFlip, TossAnnouncement, type Toss } from './components/CoinFlip.js';
import { HandFocus, handStep } from './components/HandFocus.js';
import { Inspect } from './components/Inspect.js';
import { CARD_BACK } from './components/CardImage.js';
import { abilityOf, staysOnTable, statsOf } from './state/useCardNames.js';
import { PayFor, type PayableAction } from './components/PayFor.js';
import { Peek } from './components/Peek.js';
import { Revealed, type Reveal } from './components/Revealed.js';
import { PileViewer } from './components/PileViewer.js';
import { QuickWindow } from './components/QuickWindow.js';
import { BurnAway } from './components/BurnAway.js';
import { DeckBuilder } from './components/DeckBuilder.js';
import { DeckSelect } from './components/DeckSelect.js';
import { Lobby } from './components/Lobby.js';
import { LobbyBrowser } from './components/LobbyBrowser.js';
import { Settings } from './components/Settings.js';
import { SignIn } from './components/SignIn.js';
import { turnPage } from './net/pageTurn.js';
import { playDraw, playShuffle } from './net/sound.js';
import { useAuth } from './state/useAuth.js';
import { useMatch } from './state/useMatch.js';

/**
 * Screen flow: sign in, then the lobby, then choosing a deck, then the board.
 *
 * Signing in is the gate, not a convenience: the socket connects as an
 * account and the server seats whoever the session names, so there is no
 * anonymous path to leave open. DesignNotes 1.
 */
export function App(): JSX.Element {
  const auth = useAuth();
  // The back is a CSS background in several places, so the URL — which moves
  // with the API root — is published once as a custom property.
  useEffect(() => {
    document.documentElement.style.setProperty('--card-back', `url(${CARD_BACK})`);
  }, []);
  const match = useMatch(auth.user !== null);
  // The table is a fixed viewport-sized surface, so nothing on it should ever
  // put the *document* on a scrollbar — a board you can scroll away from is a
  // board whose halves stop lining up. Flagged on the root rather than fixed
  // in a stylesheet rule so the menu screens, which do legitimately scroll,
  // are untouched.
  const playing = match.view !== null;
  useEffect(() => {
    document.documentElement.classList.toggle('is-playing', playing);
    return () => document.documentElement.classList.remove('is-playing');
  }, [playing]);
  const [building, setBuilding] = useState(false);
  const [browsing, setBrowsing] = useState(false);

  // The board is dealt behind a sheet that burns away to reveal it. Leaving
  // the menu turns the screen away like a page instead — two weights of
  // transition: a page turn moves you along, a burn starts the game.
  const [burning, setBurning] = useState(false);
  const [inspecting, setInspecting] = useState<string | null>(null);
  // Both are pure display: nothing about looking at a card leaves this tab.
  const [peeking, setPeeking] = useState<string | null>(null);
  const [grave, setGrave] = useState<string | null>(null);
  // The card being opened, held up in the middle of the board for a moment.
  const [reveal, setReveal] = useState<Reveal | null>(null);
  // A city changing hands, which is the biggest single swing on the board and
  // pays two cards for it. Rules.md §12.
  const [taken, setTaken] = useState<Taken | null>(null);
  // The toss for first player, shown once when a match deals. Rules.md §9.2 —
  // the engine has already decided it; this only says so.
  const [toss, setToss] = useState<Toss | null>(null);
  // Stable, because the toss times itself off this callback: a fresh arrow on
  // every render would restart the coin mid-spin and it would never land.
  const clearToss = useCallback(() => setToss(null), []);
  // Settings sits over whatever is underneath — the main menu or a match —
  // rather than being a screen of its own, so a game is never left to reach it.
  const [settings, setSettings] = useState(false);
  // The latest view, for effects that must not re-run when it changes.
  const viewRef = useRef(match.view);
  viewRef.current = match.view;
  // A play the player is considering and has not paid for yet. Opening costs
  // cards out of hand (Rules.md §7) and so does a cost-bearing ability (§13),
  // and which cards is their choice, so it is asked before anything is sent.
  const [opening, setOpening] = useState<PayableAction | null>(null);
  // A paid-for card waiting to be pointed at somebody. Rules.md §13 — the
  // choice is made on the board, after the cost is settled, so the player can
  // see where everybody is standing while they make it.
  const [aiming, setAiming] = useState<Aiming | null>(null);
  // Which target the pointer is over, so the arrow can snap to it.
  const [hovered, setHovered] = useState<string | null>(null);
  const dealt = useRef(false);

  // A target picker is abandoned as soon as the server moves: whoever it was
  // pointing at may not be a legal choice any more, and the arrow would be
  // lying. The same reasoning as the board's own area targeting.
  const aimedAt = useRef(match.view?.version);
  useEffect(() => {
    const version = viewRef.current?.version;
    if (aimedAt.current === version) return;
    aimedAt.current = version;
    setAiming(null);
    setHovered(null);
  }, [match.view?.version]);

  useEffect(() => {
    if (match.view && !dealt.current) {
      dealt.current = true;
      setBurning(true);
      // The opening shuffle and deal happen when the match is built, not
      // through an action, so no events describe them — the first view
      // arriving *is* the deal.
      playShuffle();

      // Rules.md §9.2 randomises the first player, and `seats[0]` is the
      // result: the engine shuffled the seats from the match seed. Announced
      // here rather than from `MATCH_STARTED`, because that event is in the
      // opening log rather than in a live batch — a player rejoining a match
      // in progress would otherwise be told the toss all over again.
      //
      // Only while the match is still in setup, for the same reason: come
      // back on turn nine and the toss is long settled.
      const view = match.view;
      const first = view.seats[0];
      if (first && view.status.kind === 'setup') {
        setToss({
          key: `${view.matchId}`,
          mine: first === view.viewer,
          who: view.players[first]?.name ?? 'Your opponent',
        });
      }
    }
    if (!match.view) dealt.current = false;
  }, [match.view]);

  // Sound follows the events the server sent, not the state it produced: the
  // events say what *happened*, which is what a sound is for. A batch is one
  // action's worth, so a seven-card deal is one run of card sounds rather
  // than seven overlapping ones.
  useEffect(() => {
    const events = match.recentEvents;
    if (events.length === 0) return;

    // A reshuffle already accounts for the redraw that follows it.
    if (events.some((e) => e.type === 'MULLIGANED' || e.type === 'MATCH_STARTED')) {
      playShuffle();
      return;
    }
    const drawn = events.filter((e) => e.type === 'CARD_DRAWN').length;
    if (drawn > 0) playDraw(drawn);
  }, [match.recentEvents]);

  // Opening is the moment a card starts mattering, and on the board it happens
  // at thumbnail size. Hold it up so both players can actually read it.
  //
  // Keyed to the event batch, not the view: `recentEvents` sits there until
  // the next action, so watching the view as well would re-raise the same
  // open on every update and the card would never come down.
  const shown = useRef<readonly GameEvent[] | null>(null);
  useEffect(() => {
    const events = match.recentEvents;
    if (events.length === 0 || shown.current === events) return;
    shown.current = events;

    const view = viewRef.current;
    if (!view) return;

    // Taking a city outranks everything else in the batch: it is the win
    // condition moving (Rules.md §1) and it hands somebody two cards. A
    // `player` of null is a city falling vacant, which pays nobody and is not
    // announced — only a seizure is.
    const seized = events.find(
      (event): event is Extract<GameEvent, { type: 'CITY_OCCUPIED' }> =>
        event.type === 'CITY_OCCUPIED' && event.player !== null,
    );
    if (seized) {
      // A city is face up by the time it can be held (Rules.md §5), so its
      // name and whether it is the Royal Capital have arrived — but the view
      // types do not know that, and a hidden city must never be read for
      // either or the Capital's position leaks.
      const found = view.cities[seized.city];
      const city = found && !isCityHidden(found) ? found : null;
      setTaken({
        key: Date.now(),
        city: seized.city,
        name: city ? city.name : null,
        royalCapital: city?.royalCapital === true,
        mine: seized.player === view.viewer,
      });
      return;
    }

    // An ability going off is the other moment a card matters enough to come
    // forward (Rules.md §13). It wins over an open in the same batch, because
    // an open that triggers something is really about the something.
    const fired = events.find((event) => event.type === 'ABILITY_RESOLVED');
    if (fired) {
      const card = view.cards[fired.card];
      if (card && 'defId' in card) {
        setReveal({
          key: Date.now(),
          defId: card.defId,
          stays: staysOnTable(card.defId),
          mine: fired.player === view.viewer,
          ability: fired.text,
        });
        return;
      }
    }

    const opened = events.find((event) => event.type === 'CARD_OPENED');
    if (!opened) return;
    const card = view.cards[opened.card];
    if (!card || !('defId' in card)) return;
    setReveal({
      key: Date.now(),
      defId: card.defId,
      stays: staysOnTable(card.defId),
      mine: opened.player === view.viewer,
    });
  }, [match.recentEvents]);

  if (auth.checking) {
    return <div className="app app--waiting">Loading…</div>;
  }

  if (!auth.user) return <SignIn auth={auth} />;

  if (building) return <DeckBuilder onExit={() => setBuilding(false)} />;

  if (!match.matchId) {
    if (browsing) {
      return (
        <LobbyBrowser
          error={match.lastError}
          onBack={() => setBrowsing(false)}
          onJoin={(matchId) => {
            setBrowsing(false);
            match.joinMatch(matchId);
          }}
        />
      );
    }

    return (
      <>
        <Lobby
          status={match.status}
          matchId={match.matchId}
          error={match.lastError}
          onCreate={() => turnPage(match.createMatch)}
          onJoin={(matchId) => turnPage(() => match.joinMatch(matchId))}
          onBuildDeck={() => setBuilding(true)}
          onBrowse={() => setBrowsing(true)}
          onSolo={() => turnPage(match.createSolo)}
          onSettings={() => setSettings(true)}
          account={auth.user}
          onSignOut={auth.signOut}
        />
        {/* After the lobby, not before: both are in the same stacking
         * context, so the one written later is the one on top. */}
        {settings && <Settings auth={auth} onClose={() => setSettings(false)} />}
      </>
    );
  }

  // Seated but not dealt: both players choose a deck first. DesignNotes 4.
  if (!match.view) {
    return (
      <DeckSelect
        matchId={match.matchId}
        lobby={match.lobby}
        viewer={auth.user.id}
        chosen={match.chosenDeck}
        error={match.lastError}
        onChoose={match.selectDeck}
        onBuildDeck={() => setBuilding(true)}
        onLeave={match.leaveMatch}
      />
    );
  }

  // Mulligan, bottoming and discarding are only about the hand, so the hand
  // comes forward and the table dims behind it.
  const step = handStep(match.view);

  // Rules.md §11 ④ — the striker has to spend all of its Power, so the split
  // is asked for rather than assumed. The engine offers one legal assignment;
  // this turns it into a choice.
  const assigning =
    match.view.legalActions.find(
      (action): action is Extract<GameAction, { type: 'ASSIGN_DAMAGE' }> =>
        action.type === 'ASSIGN_DAMAGE',
    ) ?? null;

  return (
    <div className="app app--match">
      <header className="app__header">
        <h1>Berserk</h1>
        <span className={`status status--${match.status}`}>{match.status}</span>
        {auth.user && <span className="status">{auth.user.username}</span>}
        <GameMenu
          view={match.view}
          onAction={match.submit}
          onLeave={match.leaveMatch}
          onSettings={() => setSettings(true)}
          disabled={match.status !== 'connected'}
        />
      </header>

      {match.lastError && <p className="error">{match.lastError}</p>}

      <Board
        view={match.view}
        onAction={match.submit}
        onInspect={setInspecting}
        onPeek={setPeeking}
        onOpenGrave={setGrave}
        onConsiderOpen={setOpening}
        onUseAbility={(action) => {
          // An ability that costs nothing out of hand has nothing to settle,
          // so it skips the payment dialog and goes straight to the board —
          // a "Tap:" ability (Rules.md §6) would otherwise open a panel
          // asking for none of the seven cards in your hand.
          const wants = (action.pay?.length ?? 0) > 0;
          if (wants) {
            setOpening(action);
            return;
          }
          const choices = targetChoices(match.view as PlayerView, action);
          if (choices.length === 0 || !asksForATarget(match.view as PlayerView, action)) {
            match.submit(action);
            return;
          }
          setHovered(null);
          setAiming({ source: action.card, action, choices });
        }}
        aiming={
          aiming ? { source: aiming.source, options: aiming.choices.map((c) => c.target) } : null
        }
        onAimHover={setHovered}
        onAimAt={(target) => {
          if (!aiming) return;
          const choice = aiming.choices.find((c) => c.target === target);
          if (!choice) return;
          setAiming(null);
          setHovered(null);
          // The payment the player settled on, aimed at who they picked — and
          // the rest of the engine's choices (a cost's ally) carried through.
          match.submit({ ...aiming.action, targets: choice.targets as never });
        }}
        dimmed={
          step !== null || opening !== null || assigning !== null || match.view.quick !== null
        }
      />
      <TurnButton
        view={match.view}
        onAction={match.submit}
        disabled={match.status !== 'connected'}
      />

      {step && (
        <HandFocus
          view={match.view}
          step={step}
          onAction={match.submit}
          onInspect={setInspecting}
          onPeek={setPeeking}
        />
      )}
      <Banner view={match.view} />
      {/* Blows and deaths, drawn over the table from the events that caused
       * them. Purely presentational — it reads events, never sends any. */}
      <BoardFx view={match.view} events={match.recentEvents} />
      <MatchOver
        view={match.view}
        onLeave={match.leaveMatch}
        solo={match.solo}
        onAgain={() =>
          turnPage(() => {
            match.leaveMatch();
            if (match.solo) match.createSolo();
            else match.createMatch();
          })
        }
      />
      {grave && (
        <PileViewer
          view={match.view}
          player={grave}
          onClose={() => setGrave(null)}
          onPeek={setPeeking}
        />
      )}
      {assigning && match.view.battle && (
        <AssignDamage
          view={match.view}
          action={assigning}
          power={strikerPower(match.view, assigning.card)}
          targets={battleTargets(match.view, assigning.card)}
          onConfirm={match.submit}
          onInspect={setInspecting}
        />
      )}
      {opening && (
        <PayFor
          view={match.view}
          action={opening}
          onCancel={() => setOpening(null)}
          onConfirm={(action) => {
            setOpening(null);
            // Paid for. If it has to be pointed at somebody, that happens on
            // the board now rather than in this dialog (Rules.md §13); the
            // engine offers one action per legal target, so the choices are
            // read off what it sent rather than worked out here.
            const paid = action as PayableAction;
            const choices = targetChoices(match.view as PlayerView, paid);
            if (choices.length === 0 || !asksForATarget(match.view as PlayerView, paid)) {
              match.submit(paid);
              return;
            }
            setHovered(null);
            setAiming({ source: paid.card, action: paid, choices });
          }}
          onPeek={setPeeking}
          onInspect={setInspecting}
        />
      )}
      {aiming && (
        <Aim
          source={aiming.source}
          defId={defIdOf(match.view, aiming.source)}
          options={aiming.choices.map((choice) => choice.target)}
          hovered={hovered}
          onCancel={() => {
            setAiming(null);
            setHovered(null);
          }}
        />
      )}
      {/* A Quick window freezes the game behind it (Rules.md §13), so it sits
       * over the board — but under the payment overlay it opens, and out of
       * the way while a card it opened is being pointed at somebody, which is
       * why it stands down for both. */}
      {match.view.quick?.waitingOn === match.view.viewer && opening === null && aiming === null && (
        <QuickWindow
          view={match.view}
          trigger={match.view.quick.trigger}
          onConsiderOpen={setOpening}
          onPass={() => match.submit({ type: 'PASS_PRIORITY' })}
          onPeek={setPeeking}
          onInspect={setInspecting}
        />
      )}
      {settings && <Settings auth={auth} onClose={() => setSettings(false)} />}
      {reveal && <Revealed reveal={reveal} onDone={() => setReveal(null)} />}
      {taken && <CityTaken taken={taken} onDone={() => setTaken(null)} />}
      {/* Over the mulligan, not beside it: the toss settles who acts first and
       * should be read before the opening hand is decided. It takes no pointer
       * events, so the deal animates underneath and nothing is blocked. */}
      {toss && (
        <>
          <CoinFlip toss={toss} onDone={clearToss} />
          <TossAnnouncement toss={toss} />
        </>
      )}
      {peeking && <Peek defId={peeking} />}
      {inspecting && <Inspect defId={inspecting} onClose={() => setInspecting(null)} />}
      {burning && <BurnAway onDone={() => setBurning(false)} />}
    </div>
  );
}

/** A paid-for play still waiting to be pointed at somebody. Rules.md §13. */
interface Aiming {
  /** The card doing the pointing — where the arrow starts. */
  readonly source: string;
  /** What to send, carrying the payment the player settled on. */
  readonly action: PayableAction;
  /** Each legal choice, and the full `targets` list that lands on it. */
  readonly choices: readonly Choice[];
}

interface Choice {
  readonly target: string;
  /**
   * Every choice the action carries, not merely the one being pointed at.
   *
   * A cost may name a character of its own — Rules.md §6 lets an ability lock
   * an ally to pay for itself — and the engine reads the cost's choice first
   * and the effect's second. Replacing the list with just the target would
   * drop the ally and the action would be rejected, so the list the engine
   * offered is kept whole.
   */
  readonly targets: readonly string[];
}

/**
 * Everybody this play may legally be pointed at, with the action that does it.
 *
 * Read off `legalActions`, which offers one action per legal target — the
 * client cannot work the list out for itself, because who a card may point at
 * depends on colour, Level, Distance and whether a battle is running, and
 * those are rules that live in the engine.
 */
function targetChoices(view: PlayerView, action: PayableAction): Choice[] {
  const choices: Choice[] = [];
  const seen = new Set<string>();

  for (const offered of view.legalActions) {
    if (offered.type !== action.type || offered.card !== action.card) continue;
    // A card may carry two abilities; only this one's targets are on offer.
    if (
      action.type === 'USE_ABILITY' &&
      (offered as Extract<GameAction, { type: 'USE_ABILITY' }>).ability !== action.ability
    ) {
      continue;
    }
    const targets = (offered as { targets?: readonly string[] }).targets ?? [];
    // The effect's own choice is the last one: a cost's ally comes first.
    const target = targets[targets.length - 1];
    if (target === undefined || seen.has(target)) continue;
    seen.add(target);
    choices.push({ target, targets });
  }

  return choices;
}

/**
 * Is the player actually being asked who this lands on? Rules.md §13.
 *
 * An open that carries a target always is. An ability may carry one for its
 * *cost* instead — §6's "lock a character as a cost" — which the engine
 * settles itself and the player is not choosing between, so raising the
 * targeting arrow over it would be asking a question nobody posed.
 */
function asksForATarget(view: PlayerView, action: PayableAction): boolean {
  if (action.type === 'OPEN_CARD') return true;
  const card = view.cards[action.card];
  const defId = card && 'defId' in card ? card.defId : null;
  const printed = defId ? abilityOf(defId, action.ability) : null;
  if (printed) return printed.targets;
  // The catalogue has not arrived yet. Fall back to what the engine sent: an
  // action carrying nobody asks for nobody, and one that does is worth asking
  // about — being shown a choice you did not need is recoverable, submitting
  // a target the player never picked is not.
  return (action.targets?.length ?? 0) > 0;
}

const defIdOf = (view: PlayerView, card: string): string | null => {
  const found = view.cards[card];
  return found && 'defId' in found ? found.defId : null;
};

/**
 * The striker's printed Power, which is exactly what it has to assign.
 * Rules.md §11 ④.
 */
function strikerPower(view: PlayerView, card: string): number {
  const striker = view.cards[card];
  if (!striker || !('defId' in striker)) return 0;
  // What it hits for *now*, not what is printed on it: an ability may have
  // moved it (Rules.md §13), and the engine spends the real number — so
  // reading the card database here is how a strike becomes unassignable.
  return striker.current?.power ?? statsOf(striker.defId)?.power ?? 0;
}

/** The enemies this striker may hit: participants in the battle, still standing. */
function battleTargets(
  view: PlayerView,
  card: string,
): { id: CardInstanceId; defId: string; hp: number; damage: number }[] {
  const striker = view.cards[card];
  const battle = view.battle;
  if (!striker || !battle) return [];

  return battle.participants
    .map((id) => view.cards[id])
    .filter(
      (target): target is Extract<typeof target, { defId: string }> =>
        target !== undefined &&
        'defId' in target &&
        target.zone === 'city' &&
        target.controller !== striker.controller,
    )
    .map((target) => ({
      id: target.instanceId,
      defId: target.defId,
      hp: target.current?.hp ?? statsOf(target.defId)?.hp ?? 0,
      damage: target.damage,
    }));
}
