import type { MatchId } from '@berserk/engine';
import type { OngoingMatch } from '@berserk/protocol';
import { useEffect, useState, type JSX } from 'react';
import wallpaper from '../../../../art-assets/wallpaper.jpg';
import { getSocket } from '../net/socket.js';
import { Embers } from './Embers.js';

/**
 * The main menu, centred over the Berserk wallpaper.
 *
 * The artwork supplies its own masthead — the Brand and the katakana — so this
 * screen deliberately has no wordmark of its own: a second "BERSERK" would
 * both duplicate and collide with it. The heading is present for screen
 * readers only.
 *
 * The controls sit in the lower third so they clear the katakana, and a
 * gradient scrim keeps them legible over the bright clouds in the lower
 * corners whatever the viewport aspect ratio.
 */

interface LobbyProps {
  readonly status: string;
  readonly matchId: MatchId | null;
  readonly error: string | null;
  /** With a password, a private room of its own. DesignNotes 2. */
  readonly onCreate: (password?: string) => void;
  readonly onJoin: (matchId: MatchId, password?: string) => void;
  readonly onBuildDeck: () => void;
  readonly onBrowse: () => void;
  readonly onSolo: () => void;
  readonly onSettings: () => void;
  readonly account: { username: string } | null;
  readonly onSignOut: () => void;
}

/**
 * Games this account is still seated in. DesignNotes 3.
 *
 * A dropped connection leaves the seat exactly where it was — the server keeps
 * it so the player can come back — but until this list existed there was no
 * way to find the match again short of remembering its six-digit code. So the
 * menu asks on the way in, and keeps asking while it is open: the opponent may
 * finish their turn, or concede, while this screen is up.
 *
 * Polled rather than pushed, like the lobby browser: the list is small, only
 * interesting while this screen is showing, and a few seconds of staleness
 * costs nothing.
 */
const REFRESH_MS = 5000;

function useOngoingMatches(active: boolean): readonly OngoingMatch[] {
  const [matches, setMatches] = useState<readonly OngoingMatch[]>([]);

  useEffect(() => {
    if (!active) return;
    let live = true;
    const refresh = (): void => {
      getSocket().emit('matches:mine', {}, (mine) => {
        if (live) setMatches(mine);
      });
    };
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [active]);

  return active ? matches : [];
}

export function Lobby({
  status,
  matchId,
  error,
  onCreate,
  onJoin,
  onBuildDeck,
  onBrowse,
  onSolo,
  onSettings,
  account,
  onSignOut,
}: LobbyProps): JSX.Element {
  const [joinCode, setJoinCode] = useState('');
  const [joinPassword, setJoinPassword] = useState('');
  // A room password, for a game meant for one particular person. Empty is
  // the ordinary open match.
  const [password, setPassword] = useState('');
  const connected = status === 'connected';
  const ongoing = useOngoingMatches(connected && matchId === null);

  return (
    <div className="lobby" style={{ backgroundImage: `url(${wallpaper})` }}>
      <div className="lobby__scrim" />
      <Embers />

      <div className="lobby__content">
        <h1 className="visually-hidden">Berserk Trading Card Game</h1>

        {matchId ? (
          <div className="lobby__panel">
            <p className="lobby__waiting">Waiting for an opponent…</p>
            <p className="lobby__hint">Share this join code</p>
            <code className="lobby__code">{matchId}</code>
          </div>
        ) : (
          <div className="lobby__panel">
            {/* A game already under way comes first: it is the only thing on
                this screen somebody is waiting on. Rejoining is the same
                `match:join` as any other — the seat was never given up. */}
            {ongoing.length > 0 && (
              <div className="lobby__resume">
                <p className="lobby__hint">
                  {ongoing.length === 1 ? 'You are in a game' : 'You are in these games'}
                </p>
                <ul className="browse">
                  {ongoing.map((match) => (
                    <li key={match.matchId}>
                      <button
                        type="button"
                        className="browse__row"
                        disabled={!connected}
                        onClick={() => onJoin(match.matchId)}
                      >
                        <span className="browse__code">{match.matchId}</span>
                        <span className="browse__host">{match.opponent ?? 'Waiting'}</span>
                        <span className="browse__seats">Turn {match.turnNumber}</span>
                        <span className="browse__age">
                          {match.yourTurn ? 'Your turn' : 'Their turn'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="lobby__divider">
                  <span>or</span>
                </div>
              </div>
            )}

            <button
              type="button"
              className="btn btn--primary"
              disabled={!connected}
              onClick={() => onCreate(password || undefined)}
            >
              {password ? 'Create Private Match' : 'Find / Create Match'}
            </button>
            <input
              className="lobby__password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Room password (optional)"
              aria-label="Room password"
              autoComplete="off"
            />

            <div className="lobby__divider">
              <span>or</span>
            </div>

            <button type="button" className="btn" disabled={!connected} onClick={onSolo}>
              Singleplayer
            </button>

            <button type="button" className="btn" onClick={onBrowse}>
              Browse Lobbies
            </button>

            <button type="button" className="btn" onClick={onBuildDeck}>
              Deck Builder
            </button>

            <button type="button" className="btn" onClick={onSettings}>
              Settings
            </button>

            <form
              className="lobby__join"
              onSubmit={(e) => {
                e.preventDefault();
                if (joinCode.length === 6) onJoin(joinCode as MatchId, joinPassword || undefined);
              }}
            >
              <input
                value={joinCode}
                // Join codes are six digits, so anything else is a typo. The
                // length cap lives here rather than in maxLength, which would
                // truncate a pasted value before the digits were picked out.
                onChange={(e) => setJoinCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="Join code"
                aria-label="Join code"
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
              />
              <input
                type="password"
                value={joinPassword}
                onChange={(e) => setJoinPassword(e.target.value)}
                placeholder="Password"
                aria-label="Room password, if the room has one"
                autoComplete="off"
              />
              <button type="submit" className="btn" disabled={!connected || joinCode.length !== 6}>
                Join
              </button>
            </form>
          </div>
        )}

        {error && <p className="lobby__error">{error}</p>}

        {account && (
          <p className="lobby__account">
            Signed in as <strong>{account.username}</strong>
            <button type="button" className="lobby__skip" onClick={onSignOut}>
              Sign out
            </button>
          </p>
        )}

        <p className={`lobby__status lobby__status--${status}`}>
          {connected ? 'Connected' : status === 'connecting' ? 'Connecting…' : 'Disconnected'}
        </p>
      </div>
    </div>
  );
}
