import {
  GAME_NAMESPACE,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '@berserk/protocol';
import { io, type Socket } from 'socket.io-client';
import { authToken } from './session.js';

/**
 * The single socket connection to the game server.
 *
 * The client is a *renderer*, not a rules engine: it displays the view the
 * server sends and submits intents. It must never simulate a move locally and
 * assume it happened — the server's next `state:update` is the truth.
 *
 * It also never says who it is. The session token goes up at handshake and the
 * server derives the seat from the account it names, so there is no local
 * player id to keep — and nothing a tampered client could claim.
 */

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** Empty in dev so Vite's proxy handles it; set for a separately hosted API. */
const SERVER_URL = import.meta.env['VITE_SERVER_URL'] ?? '';

let socket: GameSocket | null = null;

export function getSocket(): GameSocket {
  socket ??= io(`${SERVER_URL}${GAME_NAMESPACE}`, {
    transports: ['websocket'],
    // Nothing connects until there is an account to connect as.
    autoConnect: false,
    // A callback, not a value: it is re-read on every reconnect attempt, so
    // signing out and back in never puts a stale token on the wire.
    auth: (cb) => cb({ token: authToken() ?? '' }),
    // Matches survive a brief disconnect: the seat is held server-side.
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  });
  return socket;
}
