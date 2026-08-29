import type { GameAction, GameEvent, MatchId, PlayerView } from '@berserk/engine';
import type { MatchLobby, StateUpdate } from '@berserk/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getSocket } from '../net/socket.js';

/**
 * Owns the client's connection to one match.
 *
 * There is deliberately no local game state here beyond the last view the
 * server sent. Anything that looks like "apply the move optimistically" is a
 * desync waiting to happen; the round trip is a few milliseconds.
 *
 * Nothing here names the player. The socket authenticates once at handshake
 * and the server seats the account it finds, so `enabled` — meaning "there is
 * an account to connect as" — is the only identity this hook deals in.
 */

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface MatchClient {
  readonly status: ConnectionStatus;
  readonly view: PlayerView | null;
  readonly matchId: MatchId | null;
  /** Most recent rejection, so the UI can explain what went wrong. */
  readonly lastError: string | null;
  readonly recentEvents: readonly GameEvent[];
  /** Who is seated and who has chosen a deck, before the match deals. */
  readonly lobby: MatchLobby | null;
  /** The deck this player picked, once accepted by the server. */
  readonly chosenDeck: string | null;
  /** True when this match was started against the computer. */
  readonly solo: boolean;
  /** True when this match is the guided game. DesignNotes "Tutorial". */
  readonly tutorial: boolean;
  /** Find an open match, or with a password make a private one. DesignNotes 2. */
  createMatch: (password?: string) => void;
  /** Start a match against the computer. */
  createSolo: () => void;
  /** Start the guided game against the computer. */
  createTutorial: () => void;
  joinMatch: (matchId: MatchId, password?: string) => void;
  selectDeck: (deckId: string) => void;
  /** Deal the match once both decks are chosen. DesignNotes 3. */
  startMatch: () => void;
  /** Steps out of a match and back to the menu. */
  leaveMatch: () => void;
  submit: (action: GameAction) => void;
}

export function useMatch(enabled: boolean): MatchClient {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [view, setView] = useState<PlayerView | null>(null);
  const [matchId, setMatchId] = useState<MatchId | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [recentEvents, setRecentEvents] = useState<readonly GameEvent[]>([]);
  const [lobby, setLobby] = useState<MatchLobby | null>(null);
  const [chosenDeck, setChosenDeck] = useState<string | null>(null);
  // Whether the opponent is the computer is something this client *did*, not
  // something to infer from a seat id — the AI's player id belongs to the
  // server, and reading it here would make it part of the wire contract.
  const [solo, setSolo] = useState(false);
  const [tutorial, setTutorial] = useState(false);
  const matchIdRef = useRef<MatchId | null>(null);

  useEffect(() => {
    const socket = getSocket();

    const onConnect = (): void => {
      setStatus('connected');
      setLastError(null);
      // Reclaim the seat after a reconnect.
      const current = matchIdRef.current;
      if (current) {
        socket.emit('match:join', { matchId: current }, (result) => {
          if (result.ok) setView(result.view);
        });
      }
    };

    const onDisconnect = (): void => setStatus('disconnected');

    // A rejected handshake is almost always an expired or missing session.
    const onConnectError = (error: Error): void => {
      setStatus('disconnected');
      setLastError(error.message);
    };

    const onState = ({ view: next, events }: StateUpdate): void => {
      // Ignore out-of-order updates; the server's version only moves forward.
      setView((prev) => (prev && prev.version > next.version ? prev : next));
      // In the same handler as the view, so the two land in one render: an
      // event drawn against the view *before* it looked up a card the old
      // view still had face down, and the reveal never showed.
      if (events.length > 0) setRecentEvents(events);
    };

    const onServerError = ({ message }: { message: string }): void => setLastError(message);
    const onLobby = (payload: MatchLobby): void => setLobby(payload);

    socket.on('match:lobby', onLobby);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('state:update', onState);
    socket.on('error:server', onServerError);
    socket.on('connect_error', onConnectError);

    if (enabled) {
      if (socket.connected) onConnect();
      else socket.connect();
    } else if (socket.connected) {
      socket.disconnect();
    }

    return () => {
      socket.off('connect', onConnect);
      socket.off('connect_error', onConnectError);
      socket.off('disconnect', onDisconnect);
      socket.off('state:update', onState);
      socket.off('error:server', onServerError);
      socket.off('match:lobby', onLobby);
    };
  }, [enabled]);

  const enterMatch = useCallback((id: MatchId, next: PlayerView | null) => {
    matchIdRef.current = id;
    setMatchId(id);
    setView(next);
    // The last match's final batch must not play over this one's first view.
    setRecentEvents([]);
    setLastError(null);
  }, []);

  /**
   * Runs a click handler so a thrown exception becomes a visible message
   * instead of a button that silently does nothing. This is not paranoia:
   * `crypto.randomUUID` is absent outside secure contexts and took every
   * lobby button down with it once already.
   */
  const guard = useCallback((label: string, fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      console.error(`${label} failed`, error);
      setLastError(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  const createMatch = useCallback(
    (password?: string) => {
      setSolo(false);
      setTutorial(false);
      guard('Creating a match', () => {
        getSocket().emit('match:create', password ? { password } : {}, (result) => {
          if (result.ok) enterMatch(result.matchId, result.view);
          else setLastError(result.message);
        });
      });
    },
    [enterMatch, guard],
  );

  const createTutorial = useCallback(() => {
    setSolo(true);
    setTutorial(true);
    guard('Starting the tutorial', () => {
      getSocket().emit('match:createTutorial', (result) => {
        if (result.ok) enterMatch(result.matchId, result.view);
        else setLastError(result.message);
      });
    });
  }, [enterMatch, guard]);

  const createSolo = useCallback(() => {
    setSolo(true);
    setTutorial(false);
    guard('Starting a single-player match', () => {
      getSocket().emit('match:createSolo', (result) => {
        if (result.ok) enterMatch(result.matchId, result.view);
        else setLastError(result.message);
      });
    });
  }, [enterMatch, guard]);

  const joinMatch = useCallback(
    (id: MatchId, password?: string) => {
      setSolo(false);
      setTutorial(false);
      guard('Joining the match', () => {
        getSocket().emit(
          'match:join',
          password ? { matchId: id, password } : { matchId: id },
          (result) => {
            if (result.ok) enterMatch(result.matchId, result.view);
            else setLastError(result.message);
          },
        );
      });
    },
    [enterMatch, guard],
  );

  const startMatch = useCallback(() => {
    const id = matchIdRef.current;
    if (!id) return;
    setLastError(null);
    guard('Starting the match', () => {
      getSocket().emit('match:start', { matchId: id }, (result) => {
        if (!result.ok) setLastError(result.message);
      });
    });
  }, [guard]);

  const selectDeck = useCallback(
    (deckId: string) => {
      const id = matchIdRef.current;
      if (!id) return;
      setLastError(null);
      guard('Choosing a deck', () => {
        getSocket().emit('match:selectDeck', { matchId: id, deckId }, (result) => {
          if (result.ok) setChosenDeck(deckId);
          else setLastError(result.message);
        });
      });
    },
    [guard],
  );

  const leaveMatch = useCallback(() => {
    const id = matchIdRef.current;
    if (id) guard('Leaving the match', () => getSocket().emit('match:leave', { matchId: id }));

    // Reset regardless of whether the server heard us: the player asked to
    // leave, so being stuck on this screen is the one unacceptable outcome.
    matchIdRef.current = null;
    setMatchId(null);
    setView(null);
    setRecentEvents([]);
    setLobby(null);
    setChosenDeck(null);
    setLastError(null);
    setSolo(false);
    setTutorial(false);
  }, [guard]);

  const submit = useCallback(
    (action: GameAction) => {
      const id = matchIdRef.current;
      if (!id) return;
      setLastError(null);
      guard('Submitting the action', () => {
        getSocket().emit('action:submit', { matchId: id, action }, (result) => {
          if (!result.ok) setLastError(result.violation.message);
        });
      });
    },
    [guard],
  );

  return {
    status,
    view,
    matchId,
    lastError,
    recentEvents,
    lobby,
    chosenDeck,
    solo,
    tutorial,
    createMatch,
    createSolo,
    createTutorial,
    joinMatch,
    selectDeck,
    startMatch,
    leaveMatch,
    submit,
  };
}
