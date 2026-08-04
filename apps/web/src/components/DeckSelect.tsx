import type { MatchLobby } from '@berserk/protocol';
import { useEffect, useState, type JSX } from 'react';
import { authHeaders } from '../state/useAuth.js';
import type { SavedDeck } from '../state/useDeckBuilder.js';

/**
 * Choosing a deck once seated. DesignNotes 4.
 *
 * The client sends only a deck id — the server loads the deck itself and
 * re-checks its legality, so nothing here can put an illegal or unsaved deck
 * into a match.
 */

const API = import.meta.env['VITE_SERVER_URL'] ?? '';

interface Props {
  readonly matchId: string;
  readonly lobby: MatchLobby | null;
  readonly viewer: string;
  readonly onChoose: (deckId: string) => void;
  readonly chosen: string | null;
  readonly error: string | null;
  readonly onBuildDeck: () => void;
  readonly onLeave: () => void;
}

export function DeckSelect({
  matchId,
  lobby,
  viewer,
  onChoose,
  chosen,
  error,
  onBuildDeck,
  onLeave,
}: Props): JSX.Element {
  const [decks, setDecks] = useState<SavedDeck[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`${API}/api/decks`, {
          headers: authHeaders(),
        });
        if (response.ok) {
          const body = (await response.json()) as { decks: SavedDeck[] };
          if (!cancelled) setDecks(body.decks);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Only a legal deck can enter a match, so illegal ones are shown greyed
  // rather than hidden — otherwise a missing deck looks like a bug.
  const legal = decks.filter((deck) => deck.summary.legal);
  const illegal = decks.filter((deck) => !deck.summary.legal);

  return (
    <div className="app">
      <header className="app__header">
        <button type="button" className="btn" onClick={onLeave}>
          Leave
        </button>
        <h1>Choose a deck</h1>
        <span className="status">code {matchId}</span>
      </header>

      {error && <p className="error">{error}</p>}

      <div className="seats">
        {(lobby?.seats ?? []).map((seat) => (
          <div key={seat.playerId} className="seats__seat">
            <strong>{seat.displayName}</strong>
            {seat.playerId === viewer && <span className="badge">you</span>}
            <span className={seat.deckName ? 'seats__ready' : 'seats__waiting'}>
              {seat.deckName ?? 'choosing…'}
            </span>
          </div>
        ))}
        {(lobby?.seats.length ?? 0) < 2 && <p className="muted">Waiting for an opponent…</p>}
      </div>

      {loading ? (
        <p className="muted">Loading your decks…</p>
      ) : decks.length === 0 ? (
        <div className="empty">
          <p className="muted">You have no saved decks yet.</p>
          <button type="button" className="btn btn--primary" onClick={onBuildDeck}>
            Build one
          </button>
        </div>
      ) : (
        <>
          <ul className="pick">
            {legal.map((deck) => (
              <li key={deck.id}>
                <button
                  type="button"
                  className={chosen === deck.id ? 'pick__deck pick__deck--on' : 'pick__deck'}
                  onClick={() => onChoose(deck.id)}
                >
                  <span className="pick__name">{deck.name}</span>
                  {deck.precon && <span className="decks__tag">precon</span>}
                  <span className="pick__size">
                    {deck.summary.size} · ⚔ {deck.summary.mercenaries}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {illegal.length > 0 && (
            <div className="pick__illegal">
              <p className="muted">Not legal yet, so they cannot be played:</p>
              <ul className="pick">
                {illegal.map((deck) => (
                  <li key={deck.id}>
                    <button type="button" className="pick__deck" disabled>
                      <span className="pick__name">{deck.name}</span>
                      <span className="pick__size">{deck.summary.errors[0]?.message}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <button type="button" className="btn" onClick={onBuildDeck}>
            Deck Builder
          </button>
        </>
      )}
    </div>
  );
}
