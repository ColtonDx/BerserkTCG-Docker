import type { MatchId } from '@berserk/engine';
import { useState, type JSX } from 'react';
import wallpaper from '../../../../art-assets/wallpaper.jpg';
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
  readonly onCreate: () => void;
  readonly onJoin: (matchId: MatchId) => void;
  readonly onBuildDeck: () => void;
  readonly onBrowse: () => void;
  readonly onSolo: () => void;
  readonly onSettings: () => void;
  readonly account: { username: string } | null;
  readonly onSignOut: () => void;
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
  const connected = status === 'connected';

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
            <button
              type="button"
              className="btn btn--primary"
              disabled={!connected}
              onClick={onCreate}
            >
              Find / Create Match
            </button>

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
                if (joinCode.length === 6) onJoin(joinCode as MatchId);
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
