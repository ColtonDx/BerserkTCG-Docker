import { asPlayerId, type MatchId, type PlayerId } from '@berserk/engine';
import {
  GAME_NAMESPACE,
  type ClientToServerEvents,
  type MatchLobby,
  type OpenMatch,
  type ServerToClientEvents,
} from '@berserk/protocol';
import type { FastifyInstance } from 'fastify';
import { Server, type Socket } from 'socket.io';
import { AI_NAME, AI_PLAYER_ID, driveAi } from './ai.js';
import { findProfile, readToken } from './auth.js';
import { config } from './config.js';
import { getDeck, listPrecons } from './decks.js';
import type { MatchManager } from './matches.js';

/**
 * Socket.IO gateway: translates wire messages into `MatchManager` calls and
 * broadcasts the results.
 *
 * Two invariants worth defending in review:
 *  1. Never emit `GameState` — always a per-seat `viewFor` result, or hidden
 *     information leaks to whoever opens devtools.
 *  2. Identity comes from the handshake, never from a payload. A socket is
 *     authenticated once, before `connection` fires, and the account it names
 *     is the only seat it can ever act as. Nothing a client sends can change
 *     who it is, so there is no claim left to spoof. DesignNotes 1.
 */

type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

interface SocketSession {
  /** The signed-in account. Set at handshake; never reassigned. */
  readonly playerId: PlayerId;
  readonly displayName: string;
  matchId: MatchId | null;
}

export function registerGateway(app: FastifyInstance, matches: MatchManager): Server {
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(app.server, {
    cors: { origin: config.corsOrigins, credentials: true },
  });

  const sessions = new WeakMap<GameSocket, SocketSession>();

  /**
   * Authentication, before a single message is handled. A socket that cannot
   * name a valid session never reaches the handlers below, so none of them
   * has to ask whether the player is signed in.
   */
  io.of(GAME_NAMESPACE).use((socket, next) => {
    const auth = socket.handshake.auth as { token?: unknown } | undefined;
    const user = readToken(typeof auth?.token === 'string' ? auth.token : undefined);
    if (!user) {
      next(new Error('Sign in to play.'));
      return;
    }
    sessions.set(socket as GameSocket, {
      playerId: asPlayerId(user.id),
      displayName: user.username,
      matchId: null,
    });
    next();
  });

  io.of(GAME_NAMESPACE).on('connection', (socket: GameSocket) => {
    const session = sessions.get(socket);
    if (!session) {
      // Unreachable: the middleware above rejects anonymous sockets.
      socket.disconnect(true);
      return;
    }
    app.log.info({ socketId: socket.id, player: session.playerId }, 'client connected');

    /** Sends every seated player their own view of the match. */
    const broadcastState = (matchId: MatchId): void => {
      const match = matches.get(matchId);
      if (!match) return;

      for (const seat of match.seats) {
        const view = matches.viewFor(matchId, seat.playerId);
        if (view) {
          io.of(GAME_NAMESPACE).to(seatRoom(matchId, seat.playerId)).emit('state:update', {
            matchId,
            view,
          });
        }
      }

      io.of(GAME_NAMESPACE)
        .to(matchRoom(matchId))
        .emit('match:presence', {
          matchId,
          players: match.seats.map((s) => ({
            playerId: s.playerId,
            displayName: s.displayName,
            connected: s.connected,
          })),
        });

      // Before the deal, the lobby is what players look at: who is here and
      // who has picked a deck.
      if (!match.state) {
        const lobby: MatchLobby = {
          matchId,
          seats: match.seats.map((s) => ({
            playerId: s.playerId,
            displayName: s.displayName,
            connected: s.connected,
            deckName: s.deck?.name ?? null,
          })),
          starting: matches.readyToStart(match),
        };
        io.of(GAME_NAMESPACE).to(matchRoom(matchId)).emit('match:lobby', lobby);
      }
    };

    /**
     * The player's chosen badge, read when they take a seat.
     *
     * Read here rather than cached at handshake: a socket lives for the whole
     * visit, so a badge chosen in Settings would not reach the table until
     * the player reloaded. A server with no database still plays; it just has
     * no badges.
     */
    const badge = async (): Promise<string | null> => {
      try {
        return (await findProfile(session.playerId))?.icon ?? null;
      } catch {
        return null;
      }
    };

    const joinRooms = async (matchId: MatchId): Promise<void> => {
      await socket.join(matchRoom(matchId));
      await socket.join(seatRoom(matchId, session.playerId));
      session.matchId = matchId;
    };

    socket.on('match:create', async (ack) => {
      const match = matches.findOrCreateOpen();
      const result = matches.join(match.id, session.playerId, session.displayName, await badge());
      if (!result.ok) {
        ack({ ok: false, code: result.code, message: 'Could not create a match.' });
        return;
      }

      await joinRooms(match.id);
      // A null view means the match is still waiting for a second player.
      ack({
        ok: true,
        matchId: match.id,
        seat: session.playerId,
        view: matches.viewFor(match.id, session.playerId),
      });
      broadcastState(match.id);
    });

    socket.on('match:createSolo', async (ack) => {
      const match = matches.create();
      const seated = matches.join(match.id, session.playerId, session.displayName, await badge());
      if (!seated.ok) {
        ack({ ok: false, code: seated.code, message: 'Could not start a match.' });
        return;
      }
      matches.seatAi(match.id, AI_PLAYER_ID, AI_NAME);

      await joinRooms(match.id);
      ack({ ok: true, matchId: match.id, seat: session.playerId, view: null });
      broadcastState(match.id);
    });

    socket.on('match:join', async ({ matchId }, ack) => {
      const result = matches.join(matchId, session.playerId, session.displayName, await badge());
      if (!result.ok) {
        ack({
          ok: false,
          code: result.code,
          message: result.code === 'MATCH_FULL' ? 'That match is full.' : 'No such match.',
        });
        return;
      }

      await joinRooms(matchId);
      ack({
        ok: true,
        matchId,
        seat: session.playerId,
        view: matches.viewFor(matchId, session.playerId),
      });
      broadcastState(matchId);
    });

    socket.on('action:submit', ({ matchId, action }, ack) => {
      const result = matches.submitAction(matchId, session.playerId, action);
      if (!result.ok) {
        ack({ ok: false, violation: result.violation });
        return;
      }

      ack({ ok: true, version: result.state.version });
      io.of(GAME_NAMESPACE)
        .to(matchRoom(matchId))
        .emit('events:applied', { matchId, events: result.events });
      broadcastState(matchId);

      if (result.state.status.kind === 'finished') {
        io.of(GAME_NAMESPACE).to(matchRoom(matchId)).emit('match:ended', {
          matchId,
          winner: result.state.status.winner,
          reason: result.state.status.reason,
        });
      }

      // The computer opponent takes its turn once the human has had theirs.
      // Its events go out too, or the client only ever hears about its own
      // moves and every event-driven cue is one-sided.
      void driveAi(matches, matchId, (aiEvents) => {
        io.of(GAME_NAMESPACE)
          .to(matchRoom(matchId))
          .emit('events:applied', { matchId, events: aiEvents });
        broadcastState(matchId);
      });
    });

    socket.on('lobbies:browse', (_payload, ack) => {
      const now = Date.now();
      const open: OpenMatch[] = matches.openMatches().map((match) => ({
        matchId: match.id,
        host: match.seats[0]?.displayName ?? 'Waiting',
        seats: match.seats.length,
        capacity: 2,
        age: now - match.createdAt,
      }));
      ack(open);
    });

    socket.on('match:selectDeck', async ({ matchId, deckId }, ack) => {
      // The deck is loaded server-side from its id: a client that sent card
      // lists directly could play a deck it never saved, or an illegal one.
      let deck;
      try {
        deck = await getDeck(deckId);
      } catch (error) {
        app.log.error(error, 'loading deck failed');
        ack({ ok: false, message: 'Could not load that deck.' });
        return;
      }
      if (!deck) {
        ack({ ok: false, message: 'No such deck.' });
        return;
      }

      const result = matches.chooseDeck(matchId, session.playerId, {
        id: deck.id,
        name: deck.name,
        cards: deck.cards,
      });
      if (!result.ok) {
        ack({ ok: false, message: result.message });
        return;
      }

      // The computer takes whichever shipped deck the human did not, so a
      // single-player match never mirrors itself.
      const match = matches.get(matchId);
      const ai = match?.seats.find((seat) => seat.ai);
      if (ai && !ai.deck) {
        try {
          const precons = await listPrecons();
          const other = precons.find((candidate) => candidate.id !== deck.id) ?? precons[0];
          if (other) {
            matches.chooseDeck(matchId, ai.playerId, {
              id: other.id,
              name: other.name,
              cards: other.cards,
            });
          }
        } catch (error) {
          app.log.error(error, 'choosing a deck for the computer failed');
        }
      }

      ack({ ok: true, deckName: deck.name });
      broadcastState(matchId);
      void driveAi(matches, matchId, (aiEvents) => {
        io.of(GAME_NAMESPACE)
          .to(matchRoom(matchId))
          .emit('events:applied', { matchId, events: aiEvents });
        broadcastState(matchId);
      });
    });

    socket.on('state:resync', ({ matchId }, ack) => {
      ack(matches.viewFor(matchId, session.playerId));
    });

    socket.on('match:leave', ({ matchId }) => {
      const { removed } = matches.leave(matchId, session.playerId);
      void socket.leave(matchRoom(matchId));
      void socket.leave(seatRoom(matchId, session.playerId));
      session.matchId = null;

      // Nothing left to tell anyone about if the match itself is gone.
      if (!removed) broadcastState(matchId);
    });

    socket.on('disconnect', (reason) => {
      app.log.info({ socketId: socket.id, reason }, 'client disconnected');
      if (!session.matchId) return;
      // The seat is kept so the player can reconnect and resume the match.
      matches.setConnected(session.matchId, session.playerId, false);
      broadcastState(session.matchId);
    });
  });

  return io;
}

const matchRoom = (matchId: MatchId): string => `match:${matchId}`;
const seatRoom = (matchId: MatchId, playerId: PlayerId): string => `match:${matchId}:${playerId}`;
