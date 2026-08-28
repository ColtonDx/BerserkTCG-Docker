import {
  MAX_COPIES,
  copiesRemaining,
  summariseDeck,
  type CatalogueCard,
  type DeckEntry,
  type DeckSummary,
} from '@berserk/engine';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { authHeaders } from './useAuth.js';

/**
 * Deck building state.
 *
 * Legality is computed locally from the same engine rules the server uses, so
 * counts and warnings update as fast as the player clicks. The server re-checks
 * on save and when a deck enters a match — the local copy is for feedback, not
 * authority.
 */

const API = import.meta.env['VITE_SERVER_URL'] ?? '';

export interface SavedDeck {
  readonly id: string;
  readonly name: string;
  readonly precon: boolean;
  readonly cards: readonly DeckEntry[];
  readonly summary: DeckSummary;
  readonly updatedAt: string;
}

export interface DeckBuilder {
  readonly catalogue: readonly CatalogueCard[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly decks: readonly SavedDeck[];
  readonly storageAvailable: boolean;

  readonly deckId: string | null;
  readonly name: string;
  readonly entries: readonly DeckEntry[];
  readonly summary: DeckSummary;
  readonly dirty: boolean;

  setName: (name: string) => void;
  add: (cardId: string) => void;
  remove: (cardId: string) => void;
  clear: () => void;
  quantityOf: (cardId: string) => number;
  canAdd: (cardId: string) => boolean;

  newDeck: () => void;
  /** A fresh, unsaved copy of what is being built, to fork from. */
  duplicate: () => void;
  load: (deckId: string) => void;
  save: () => Promise<void>;
  destroy: (deckId: string) => Promise<void>;
  saving: boolean;
}

export function useDeckBuilder(): DeckBuilder {
  const [catalogue, setCatalogue] = useState<CatalogueCard[]>([]);
  const [decks, setDecks] = useState<SavedDeck[]>([]);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [deckId, setDeckId] = useState<string | null>(null);
  const [name, setName] = useState('New deck');
  const [entries, setEntries] = useState<DeckEntry[]>([]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`${API}/api/catalogue`);
        if (!response.ok) throw new Error(`catalogue: ${response.status}`);
        const body = (await response.json()) as { cards: CatalogueCard[] };
        if (!cancelled) setCatalogue(body.cards);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshDecks = useCallback(async () => {
    try {
      const response = await fetch(`${API}/api/decks`, {
        headers: authHeaders(),
      });
      if (response.status === 503) {
        // No database configured; building still works, saving does not.
        setStorageAvailable(false);
        return;
      }
      if (!response.ok) throw new Error(`decks: ${response.status}`);
      const body = (await response.json()) as { decks: SavedDeck[] };
      setStorageAvailable(true);
      setDecks(body.decks);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refreshDecks();
  }, [refreshDecks]);

  const summary = useMemo(() => summariseDeck(entries), [entries]);

  const quantityOf = useCallback(
    (cardId: string) => entries.find((entry) => entry.cardId === cardId)?.quantity ?? 0,
    [entries],
  );

  const canAdd = useCallback((cardId: string) => copiesRemaining(entries, cardId) > 0, [entries]);

  const add = useCallback((cardId: string) => {
    setEntries((current) => {
      if (copiesRemaining(current, cardId) <= 0) return current;
      const existing = current.find((entry) => entry.cardId === cardId);
      setDirty(true);
      return existing
        ? current.map((entry) =>
            entry.cardId === cardId ? { ...entry, quantity: entry.quantity + 1 } : entry,
          )
        : [...current, { cardId, quantity: 1 }];
    });
  }, []);

  const remove = useCallback((cardId: string) => {
    setEntries((current) => {
      const existing = current.find((entry) => entry.cardId === cardId);
      if (!existing) return current;
      setDirty(true);
      return existing.quantity <= 1
        ? current.filter((entry) => entry.cardId !== cardId)
        : current.map((entry) =>
            entry.cardId === cardId ? { ...entry, quantity: entry.quantity - 1 } : entry,
          );
    });
  }, []);

  const clear = useCallback(() => {
    setEntries([]);
    setDirty(true);
  }, []);

  const newDeck = useCallback(() => {
    setDeckId(null);
    setName('New deck');
    setEntries([]);
    setDirty(false);
  }, []);

  const duplicate = useCallback(() => {
    setDeckId(null);
    setName((current) => `${current.replace(/ \(copy\)$/, '')} (copy)`);
    setDirty(true);
  }, []);

  const load = useCallback(
    (id: string) => {
      const deck = decks.find((candidate) => candidate.id === id);
      if (!deck) return;
      // A precon is a starting point, not something to overwrite.
      setDeckId(deck.precon ? null : deck.id);
      setName(deck.precon ? `${deck.name} (copy)` : deck.name);
      setEntries([...deck.cards]);
      setDirty(deck.precon);
    },
    [decks],
  );

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const body = JSON.stringify({ name, cards: entries });
      const headers = authHeaders({ 'content-type': 'application/json' });
      const response = deckId
        ? await fetch(`${API}/api/decks/${deckId}`, { method: 'PUT', headers, body })
        : await fetch(`${API}/api/decks`, { method: 'POST', headers, body });

      if (response.status === 503) {
        setStorageAvailable(false);
        throw new Error('Saving needs a database.');
      }
      if (!response.ok) throw new Error(`save failed: ${response.status}`);

      const saved = (await response.json()) as SavedDeck;
      setDeckId(saved.id);
      setDirty(false);
      await refreshDecks();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [deckId, entries, name, refreshDecks]);

  const destroy = useCallback(
    async (id: string) => {
      try {
        const response = await fetch(`${API}/api/decks/${id}`, {
          method: 'DELETE',
          headers: authHeaders(),
        });
        if (!response.ok && response.status !== 204) throw new Error(`delete: ${response.status}`);
        if (id === deckId) newDeck();
        await refreshDecks();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [deckId, newDeck, refreshDecks],
  );

  return {
    catalogue,
    loading,
    error,
    decks,
    storageAvailable,
    deckId,
    name,
    entries,
    summary,
    dirty,
    setName: (value: string) => {
      setName(value);
      setDirty(true);
    },
    add,
    remove,
    clear,
    quantityOf,
    canAdd,
    newDeck,
    duplicate,
    load,
    save,
    destroy,
    saving,
  };
}

export { MAX_COPIES };
