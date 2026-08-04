import type { CardInstanceId, GameAction, GameEvent, PlayerView } from '@berserk/engine';
import { useEffect, useRef, useState, type JSX } from 'react';
import { GameMenu } from './components/GameMenu.js';
import { MatchOver } from './components/MatchOver.js';
import { TurnButton } from './components/TurnButton.js';
import { AssignDamage } from './components/AssignDamage.js';
import { Banner } from './components/Banner.js';
import { Board } from './components/Board.js';
import { HandFocus, handStep } from './components/HandFocus.js';
import { Inspect } from './components/Inspect.js';
import { CARD_BACK } from './components/CardImage.js';
import { staysOnTable, statsOf } from './state/useCardNames.js';
import { PayFor } from './components/PayFor.js';
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
  // Settings sits over whatever is underneath — the main menu or a match —
  // rather than being a screen of its own, so a game is never left to reach it.
  const [settings, setSettings] = useState(false);
  // The latest view, for effects that must not re-run when it changes.
  const viewRef = useRef(match.view);
  viewRef.current = match.view;
  // An open the player is considering. Opening costs cards out of hand
  // (Rules.md §7), and which ones is their choice, so it is asked before it
  // is sent.
  const [opening, setOpening] = useState<Extract<GameAction, { type: 'OPEN_CARD' }> | null>(null);
  const dealt = useRef(false);

  useEffect(() => {
    if (match.view && !dealt.current) {
      dealt.current = true;
      setBurning(true);
      // The opening shuffle and deal happen when the match is built, not
      // through an action, so no events describe them — the first view
      // arriving *is* the deal.
      playShuffle();
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
        />
      )}
      {opening && (
        <PayFor
          view={match.view}
          action={opening}
          onCancel={() => setOpening(null)}
          onConfirm={(action) => {
            setOpening(null);
            match.submit(action);
          }}
          onPeek={setPeeking}
        />
      )}
      {/* A Quick window freezes the game behind it, so it sits above the
       * board and below only Settings. Rules.md §13. */}
      {match.view.quick?.waitingOn === match.view.viewer && opening === null && (
        <QuickWindow
          view={match.view}
          trigger={match.view.quick.trigger}
          onConsiderOpen={setOpening}
          onPass={() => match.submit({ type: 'PASS_PRIORITY' })}
          onPeek={setPeeking}
        />
      )}
      {/* A Quick window freezes the game behind it (Rules.md §13), so it sits
       * over the board — but under the payment overlay it opens, which is why
       * it stands down while one is up. */}
      {match.view.quick?.waitingOn === match.view.viewer && opening === null && (
        <QuickWindow
          view={match.view}
          trigger={match.view.quick.trigger}
          onConsiderOpen={setOpening}
          onPass={() => match.submit({ type: 'PASS_PRIORITY' })}
          onPeek={setPeeking}
        />
      )}
      {settings && <Settings auth={auth} onClose={() => setSettings(false)} />}
      {reveal && <Revealed reveal={reveal} onDone={() => setReveal(null)} />}
      {peeking && <Peek defId={peeking} />}
      {inspecting && <Inspect defId={inspecting} onClose={() => setInspecting(null)} />}
      {burning && <BurnAway onDone={() => setBurning(false)} />}
    </div>
  );
}

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
