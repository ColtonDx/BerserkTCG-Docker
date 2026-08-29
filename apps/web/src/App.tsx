import {
  isCityHidden,
  type CardInstanceId,
  type GameAction,
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
import { PickArea } from './components/PickArea.js';
import { Peek } from './components/Peek.js';
import { Revealed, type Reveal } from './components/Revealed.js';
import { PileViewer } from './components/PileViewer.js';
import { QuickPrompt } from './components/QuickPrompt.js';
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
import { usePresentation, type Stage } from './state/usePresentation.js';

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
  // What is being shown right now, and whether it is holding the stage
  // against a prompt. One queue for every overlay — see `usePresentation`.
  const { stage, busy, speaking, shown } = usePresentation(match.recentEvents, match.view);
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
  /**
   * How far into the opening ceremony the match is.
   *
   * These three happen in order and each one waits for the last: the menu
   * burns off the board, the toss decides who goes first (Rules.md §9.2), and
   * only then is the player asked about their opening hand (§9.4). They used
   * to be independent flags all set in the same tick, which played the burn,
   * the coin and the mulligan on top of each other — the start of a match is
   * the one moment with three things to say and no reason to say them at once.
   *
   * `'playing'` is both the end of the sequence and the state a player
   * rejoining a match in progress starts in: there is no ceremony to replay.
   */
  const [ceremony, setCeremony] = useState<Ceremony>('playing');
  const [inspecting, setInspecting] = useState<string | null>(null);
  // Both are pure display: nothing about looking at a card leaves this tab.
  const [peeking, setPeeking] = useState<string | null>(null);
  const [grave, setGrave] = useState<string | null>(null);
  // The toss for first player, shown once when a match deals. Rules.md §9.2 —
  // the engine has already decided it; this only says so.
  const [toss, setToss] = useState<Toss | null>(null);
  // Both stable, because each stage times itself off its callback: a fresh
  // arrow on every render would restart the burn or the coin mid-flight and
  // neither would ever finish.
  //
  // The toss is kept rather than cleared when it ends — `TossAnnouncement`
  // has already said it, and the stage is what decides whether it draws.
  const burnDone = useCallback(() => setCeremony('toss'), []);
  const tossDone = useCallback(() => {
    setCeremony('playing');
    // The deal is heard here rather than when the view arrived. The cards were
    // dealt server-side before any of this began — there is no event for it,
    // the first view *is* the deal — but the hand does not appear until the
    // ceremony clears, and a shuffle played under the burn is a shuffle for
    // cards the player will not see for another six seconds.
    playShuffle();
  }, []);
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
  /**
   * A play whose character is settled and whose *area* is not. Rules.md §13 —
   * BK1-032 moves an enemy "to an adjacent area", and which one is a real
   * choice anywhere but the ends of the row. Asked after the target, because
   * the legal areas are the neighbours of wherever that character stands.
   */
  const [sending, setSending] = useState<Sending | null>(null);
  const dealt = useRef(false);
  // Stable, because the Quick prompt's countdown is keyed on it: a fresh
  // arrow every render would restart the clock and it would never run out.
  const passQuick = useCallback(() => match.submit({ type: 'PASS_PRIORITY' }), [match.submit]);

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
    // Same reasoning: the character it was going to move may not be there any
    // more, so the areas on offer would be describing a board that has moved.
    setSending(null);
  }, [match.view?.version]);

  useEffect(() => {
    if (match.view && !dealt.current) {
      dealt.current = true;

      // Rules.md §9.2 randomises the first player, and `seats[0]` is the
      // result: the engine shuffled the seats from the match seed. Read here
      // rather than from `MATCH_STARTED`, because that event is in the
      // opening log rather than in a live batch — a player rejoining a match
      // in progress would otherwise be told the toss all over again.
      //
      // Only while the match is still in setup, for the same reason: come
      // back on turn nine and the toss is long settled. Rejoining mid-match
      // therefore skips straight to `'playing'` and nothing is replayed.
      const view = match.view;
      const first = view.seats[0];
      if (first && view.status.kind === 'setup') {
        setToss({
          key: `${view.matchId}`,
          mine: first === view.viewer,
          who: view.players[first]?.name ?? 'Your opponent',
        });
        setCeremony('burn');
      } else {
        // Rejoining a match already under way: no ceremony to play, so the
        // shuffle is the only thing to say and it belongs here.
        setCeremony('playing');
        playShuffle();
      }
    }
    if (!match.view) {
      dealt.current = false;
      setCeremony('playing');
      setToss(null);
    }
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

    // Steel drawn, and the two cards a city pays (Rules.md §12), are heard on
    // the beats that show them — see `BoardFx`. The draws counted here are
    // the ones before any seizure in the batch: the turn's draw, an ability's.
    const seized = events.findIndex((e) => e.type === 'CITY_OCCUPIED' && e.player !== null);
    const before = seized < 0 ? events : events.slice(0, seized);
    const drawn = before.filter((e) => e.type === 'CARD_DRAWN').length;
    if (drawn > 0) playDraw(drawn);
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
          onJoin={(matchId, password) => {
            setBrowsing(false);
            match.joinMatch(matchId, password);
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
          onCreate={(password) => turnPage(() => match.createMatch(password))}
          onJoin={(matchId, password) => turnPage(() => match.joinMatch(matchId, password))}
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
        onStart={match.startMatch}
      />
    );
  }

  // The board as the beats have told it so far — see `usePresentation`. The
  // authoritative view is `match.view`; this is the picture of it to draw.
  const table = shown ?? match.view;

  // Mulligan, bottoming and discarding are only about the hand, so the hand
  // comes forward and the table dims behind it.
  const step = handStep(table);

  // Rules.md §11 ④ — the striker has to spend all of its Power, so the split
  // is asked for rather than assumed. The engine offers one legal assignment;
  // this turns it into a choice.
  const assigning =
    table.legalActions.find(
      (action): action is Extract<GameAction, { type: 'ASSIGN_DAMAGE' }> =>
        action.type === 'ASSIGN_DAMAGE',
    ) ?? null;

  // The card on stage, if the current beat is holding one up, and the city
  // on stage if one has just changed hands. Both read off the queue rather
  // than off the batch, so they come in turn — and off the *current* view,
  // which has long caught up with the event by the time its beat plays.
  const reveal = revealFrom(stage, table);
  const taken = takenFrom(stage, table);

  /**
   * Reaching for a cost-bearing ability (Rules.md §13), from the card's menu
   * or from a Quick prompt. An ability that costs nothing out of hand has
   * nothing to settle, so it skips the payment dialog and goes straight to
   * the board — a "Tap:" ability (§6) would otherwise open a panel asking
   * for none of the seven cards in your hand.
   */
  const useAbility = (action: Extract<GameAction, { type: 'USE_ABILITY' }>): void => {
    const view = table as PlayerView;
    const wants = (action.pay?.length ?? 0) > 0;
    if (wants) {
      setOpening(action);
      return;
    }
    const choices = targetChoices(view, action);
    if (choices.length === 0 || !asksForATarget(view, action)) {
      match.submit(action);
      return;
    }
    setHovered(null);
    setAiming({ source: action.card, action, choices });
  };

  return (
    <div className="app app--match">
      <header className="app__header">
        <h1>Berserk</h1>
        <span className={`status status--${match.status}`}>{match.status}</span>
        {auth.user && <span className="status">{auth.user.username}</span>}
        <GameMenu
          view={table}
          onAction={match.submit}
          onLeave={match.leaveMatch}
          onSettings={() => setSettings(true)}
          disabled={match.status !== 'connected'}
        />
      </header>

      {match.lastError && <p className="error">{match.lastError}</p>}

      <Board
        view={table}
        onAction={match.submit}
        onInspect={setInspecting}
        onPeek={setPeeking}
        onOpenGrave={setGrave}
        onConsiderOpen={setOpening}
        onUseAbility={useAbility}
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

          // Some abilities want an area as well as a character — "move it to
          // an adjacent area" (Rules.md §13). Which areas are legal depends on
          // where the chosen character stands, so it is asked second, once
          // that is settled. One option is not a question: the engine offered
          // exactly one, so it is taken.
          if (choice.areas.length > 1) {
            setSending({ action: aiming.action, targets: choice.targets, areas: choice.areas });
            return;
          }
          // The payment the player settled on, aimed at who they picked — and
          // the rest of the engine's choices (a cost's ally) carried through.
          match.submit({
            ...aiming.action,
            targets: choice.targets as never,
            ...(choice.areas.length === 1 ? { areas: choice.areas as never } : {}),
          });
        }}
        // A Quick window no longer dims the table: a Quick is a decision
        // about the board, and it was being asked blind.
        dimmed={step !== null || opening !== null || assigning !== null}
        busy={busy}
      />
      <TurnButton
        view={table}
        onAction={match.submit}
        disabled={match.status !== 'connected' || busy}
      />

      {/* Last of the three. The opening hand is a decision (Rules.md §9.4),
       * and asking for one while the board is still burning in and the coin
       * is still in the air is asking someone to choose during the fanfare.
       * And a question about the hand waits for whatever is on stage — with
       * one exception: setup, where nothing is ever on stage and the fan must
       * not blink between one bottomed card and the next. */}
      {step && ceremony === 'playing' && (!speaking || table.status.kind === 'setup') && (
        <HandFocus
          view={table}
          step={step}
          onAction={match.submit}
          onInspect={setInspecting}
          onPeek={setPeeking}
        />
      )}
      <Banner stage={stage} viewer={table.viewer} />
      {/* Blows, deaths and a city waking, drawn over the table from the beat
       * on stage. Purely presentational — it reads beats, never sends. */}
      <BoardFx view={table} stage={stage} />
      <MatchOver
        busy={busy}
        view={table}
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
          view={table}
          player={grave}
          onClose={() => setGrave(null)}
          onPeek={setPeeking}
          onInspect={setInspecting}
        />
      )}
      {/* Not while the last band is still landing: the dialog for the next
       * striker was opening over the blows of the one before. */}
      {assigning && table.battle && !busy && (
        <AssignDamage
          view={table}
          action={assigning}
          power={strikerPower(table, assigning.card)}
          targets={battleTargets(table, assigning.card)}
          onConfirm={match.submit}
          onInspect={setInspecting}
        />
      )}
      {opening && (
        <PayFor
          view={table}
          action={opening}
          onCancel={() => setOpening(null)}
          onConfirm={(action) => {
            setOpening(null);
            // Paid for. If it has to be pointed at somebody, that happens on
            // the board now rather than in this dialog (Rules.md §13); the
            // engine offers one action per legal target, so the choices are
            // read off what it sent rather than worked out here.
            const paid = action as PayableAction;
            const choices = targetChoices(table as PlayerView, paid);
            if (choices.length === 0 || !asksForATarget(table as PlayerView, paid)) {
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
      {sending && (
        <PickArea
          view={table}
          areas={sending.areas}
          onCancel={() => setSending(null)}
          onPick={(area) => {
            setSending(null);
            match.submit({
              ...sending.action,
              ...(sending.targets.length > 0 ? { targets: sending.targets as never } : {}),
              areas: [area] as never,
            });
          }}
        />
      )}
      {aiming && (
        <Aim
          source={aiming.source}
          defId={defIdOf(table, aiming.source)}
          options={aiming.choices.map((choice) => choice.target)}
          hovered={hovered}
          onCancel={() => {
            setAiming(null);
            setHovered(null);
          }}
        />
      )}
      {/* A Quick window freezes the game (Rules.md §13). The prompt waits for
       * whatever is on stage — it used to land in the same frame as the
       * reveal of the very card it was answering — and stands down under the
       * payment overlay it opens and while a card is being pointed. */}
      {table.quick?.waitingOn === table.viewer && !busy && opening === null && aiming === null && (
        <QuickPrompt
          view={table}
          trigger={table.quick.trigger}
          onConsiderOpen={setOpening}
          onUseAbility={useAbility}
          onPass={passQuick}
          onPeek={setPeeking}
          onInspect={setInspecting}
        />
      )}
      {settings && <Settings auth={auth} onClose={() => setSettings(false)} />}
      {reveal && <Revealed reveal={reveal} />}
      {taken && <CityTaken taken={taken} />}
      {/* After the burn and before the mulligan: the toss settles who acts
       * first (Rules.md §9.2), which is worth reading before deciding whether
       * to keep a hand. It takes no pointer events, so the deal animates
       * underneath it. */}
      {ceremony === 'toss' && toss && (
        <>
          <CoinFlip toss={toss} onDone={tossDone} />
          <TossAnnouncement toss={toss} />
        </>
      )}
      {peeking && <Peek defId={peeking} />}
      {inspecting && <Inspect defId={inspecting} onClose={() => setInspecting(null)} />}
      {/* The sheet burns off the board, and only when it is gone does the
       * toss begin. Chained rather than timed: the burn measures itself and
       * reports back, so nothing has to guess how long it takes. */}
      {ceremony === 'burn' && <BurnAway onDone={burnDone} />}
    </div>
  );
}

/**
 * The card the current beat holds up, if any. Rules.md §7, §13.
 *
 * Read off the view as it stands when the beat plays: a Normal Effect is in
 * the Trash by then and a Trash is public (§15), so an opponent's card is
 * always readable here — which it was not when this read the batch against
 * the view *before* it.
 */
function revealFrom(stage: Stage | null, view: PlayerView): Reveal | null {
  if (!stage) return null;
  const { beat, key } = stage;
  if (beat.kind !== 'open' && beat.kind !== 'ability' && beat.kind !== 'reveal') return null;
  const card = view.cards[beat.card];
  if (!card || !('defId' in card)) return null;
  const ability =
    beat.kind === 'open' ? beat.ability : beat.kind === 'ability' ? beat.text : undefined;
  return {
    key,
    defId: card.defId,
    stays: staysOnTable(card.defId),
    mine: beat.player === view.viewer,
    opened: beat.kind === 'open',
    revealed: beat.kind === 'reveal',
    ...(ability !== undefined ? { ability } : {}),
    fizzled: beat.kind !== 'reveal' && beat.fizzled === true,
    ms: beat.ms,
  };
}

/** The city the current beat announces as taken, if any. Rules.md §12. */
function takenFrom(stage: Stage | null, view: PlayerView): Taken | null {
  if (!stage || stage.beat.kind !== 'cityTaken') return null;
  const { beat, key } = stage;
  // A city is face up by the time it can be held (Rules.md §5), so its name
  // and whether it is the Royal Capital have arrived — but the view types do
  // not know that, and a hidden city must never be read for either or the
  // Capital's position leaks.
  const found = view.cities[beat.city];
  const city = found && !isCityHidden(found) ? found : null;
  return {
    key,
    city: beat.city,
    name: city ? city.name : null,
    royalCapital: city?.royalCapital === true,
    mine: beat.player === view.viewer,
    ms: beat.ms,
  };
}

/**
 * The opening ceremony, in the order it happens.
 *
 * `'burn'` — the menu is burning off the board.
 * `'toss'` — the coin is deciding who goes first (Rules.md §9.2).
 * `'playing'` — done, and everything else may show.
 *
 * A stage rather than three booleans because they are strictly sequential and
 * each waits for the last. Three flags set together is what made the burn, the
 * coin and the mulligan play at once.
 */
type Ceremony = 'burn' | 'toss' | 'playing';

/**
 * A play whose character is chosen and whose area is not. Rules.md §13.
 *
 * The second half of an ability that names both — see `PickArea`. Everything
 * needed to send it is already here; only the area is outstanding.
 */
interface Sending {
  readonly action: PayableAction;
  readonly targets: readonly string[];
  /** The legal areas, as the engine offered them. */
  readonly areas: readonly number[];
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
  /**
   * The areas this target may be sent to, if the ability asks for one — one
   * entry per offer the engine made for this character (Rules.md §13, e.g.
   * BK1-032's "move it to an adjacent area"). Empty when no area is wanted,
   * which is every other card in the set.
   *
   * Kept per-target rather than flattened, because "adjacent" is adjacent to
   * *that* character: two different targets can offer different areas.
   */
  readonly areas: readonly number[];
}

/** `Choice` while it is still gathering its areas. */
type Mutable = Omit<Choice, 'areas'> & { areas: number[] };

/**
 * Everybody this play may legally be pointed at, with the action that does it.
 *
 * Read off `legalActions`, which offers one action per legal target — the
 * client cannot work the list out for itself, because who a card may point at
 * depends on colour, Level, Distance and whether a battle is running, and
 * those are rules that live in the engine.
 */
function targetChoices(view: PlayerView, action: PayableAction): Choice[] {
  // Built mutably: an ability that wants an area is offered once per pair, so
  // the same target arrives repeatedly and gathers its areas as it goes.
  const choices: Mutable[] = [];
  const seen = new Map<string, Mutable>();

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
    if (target === undefined) continue;

    // An ability wanting an area is offered once per (character, area) pair,
    // so the same target arrives several times. The arrow still points at one
    // character — the areas are gathered onto it and asked for afterwards.
    const area = (offered as { areas?: readonly number[] }).areas?.[0];
    const already = seen.get(target);
    if (already) {
      if (area !== undefined && !already.areas.includes(area)) already.areas.push(area);
      continue;
    }
    const choice = { target, targets, areas: area === undefined ? [] : [area] };
    seen.set(target, choice);
    choices.push(choice);
  }

  return choices;
}

/**
 * The areas this play may be pointed at when it asks for no character —
 * one offer per area, read off `legalActions` the way targets are.
 */
function areaChoices(view: PlayerView, action: PayableAction): number[] {
  const areas: number[] = [];
  for (const offered of view.legalActions) {
    if (offered.type !== action.type || offered.card !== action.card) continue;
    if (
      action.type === 'USE_ABILITY' &&
      (offered as Extract<GameAction, { type: 'USE_ABILITY' }>).ability !== action.ability
    ) {
      continue;
    }
    const targets = (offered as { targets?: readonly string[] }).targets ?? [];
    if (targets.length > 0) continue;
    const area = (offered as { areas?: readonly number[] }).areas?.[0];
    if (area !== undefined && !areas.includes(area)) areas.push(area);
  }
  return areas;
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
