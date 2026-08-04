import type { MatchId } from '@berserk/engine';
import type { OpenMatch } from '@berserk/protocol';
import { useEffect, useState, type JSX } from 'react';
import wallpaper from '../../../../art-assets/wallpaper.jpg';
import { getSocket } from '../net/socket.js';
import { Embers } from './Embers.js';

/**
 * Matches waiting for an opponent. TODO item 6.
 *
 * Polls rather than subscribing: the list is small, only interesting while
 * this screen is open, and a few seconds of staleness costs nothing — a match
 * that filled in the meantime simply reports itself full on the way in.
 */

const REFRESH_MS = 4000;

interface Props {
  readonly onJoin: (matchId: MatchId) => void;
  readonly onBack: () => void;
  readonly error: string | null;
}

export function LobbyBrowser({ onJoin, onBack, error }: Props): JSX.Element {
  const [matches, setMatches] = useState<OpenMatch[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    const refresh = (): void => {
      getSocket().emit('lobbies:browse', {}, (open) => {
        if (!live) return;
        setMatches(open);
        setLoaded(true);
      });
    };
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="lobby" style={{ backgroundImage: `url(${wallpaper})` }}>
      <div className="lobby__scrim" />
      <Embers />

      <div className="lobby__content lobby__content--wide">
        <h1 className="visually-hidden">Open matches</h1>
        <p className="lobby__hint">Open matches</p>

        {error && <p className="lobby__error">{error}</p>}

        {!loaded ? (
          <p className="lobby__status">Looking…</p>
        ) : matches.length === 0 ? (
          <p className="lobby__status">No one is waiting right now</p>
        ) : (
          <ul className="browse">
            {matches.map((match) => (
              <li key={match.matchId}>
                <button type="button" className="browse__row" onClick={() => onJoin(match.matchId)}>
                  <span className="browse__code">{match.matchId}</span>
                  <span className="browse__host">{match.host}</span>
                  <span className="browse__seats">
                    {match.seats}/{match.capacity}
                  </span>
                  <span className="browse__age">{describeAge(match.age)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <button type="button" className="btn" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}

function describeAge(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}
