import { DECK_SIZE, MIN_MERCENARIES, type CatalogueCard } from '@berserk/engine';
import { useMemo, useState, type JSX } from 'react';
import { useDeckBuilder } from '../state/useDeckBuilder.js';
import { useCardNames } from '../state/useCardNames.js';
import { Inspect } from './Inspect.js';

/**
 * The deck builder: browse all 448 cards, build a 45-card deck, see legality
 * update as you go.
 *
 * The rules shown here come from the engine, not from anything reimplemented
 * in the UI — the same `summariseDeck` the server calls. That keeps the
 * feedback honest, and means a rules change lands in both places at once.
 */

const CARD_ROOT = import.meta.env['VITE_SERVER_URL'] ?? '';

type ColourFilter = 'all' | 'white' | 'green' | 'black' | 'red';

interface Props {
  readonly onExit: () => void;
}

export function DeckBuilder({ onExit }: Props): JSX.Element {
  const builder = useDeckBuilder();
  const [set, setSet] = useState('all');
  const [colour, setColour] = useState<ColourFilter>('all');
  const [mercenariesOnly, setMercenariesOnly] = useState(false);
  const [search, setSearch] = useState('');
  // The card being read, by printed number. Rules text and stats come from the
  // same `/api/catalogue` the table uses, so `useCardNames` has to have run.
  const [inspecting, setInspecting] = useState<string | null>(null);
  useCardNames();

  const sets = useMemo(
    () => [...new Set(builder.catalogue.map((card) => card.set))].sort(),
    [builder.catalogue],
  );

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return builder.catalogue.filter((card) => {
      if (set !== 'all' && card.set !== set) return false;
      if (colour !== 'all' && card.color !== colour) return false;
      if (mercenariesOnly && !card.mercenary) return false;
      // Name *or* number: the grid shows names now, so a search that only
      // matched `BK1-011` would find nothing for "guts" — which is what
      // anybody looking for a card actually types.
      if (
        needle &&
        !card.id.toLowerCase().includes(needle) &&
        !(card.name ?? '').toLowerCase().includes(needle)
      ) {
        return false;
      }
      return true;
    });
  }, [builder.catalogue, set, colour, mercenariesOnly, search]);

  const chosen = useMemo(
    () =>
      builder.entries
        .map((entry) => ({
          entry,
          card: builder.catalogue.find((card) => card.id === entry.cardId),
        }))
        // By the name the list actually shows, so the order reads as
        // alphabetical rather than as an arbitrary shuffle. Ties — several
        // printings share a name — fall back to the number, which keeps them
        // adjacent and in set order.
        .sort(
          (a, b) =>
            (a.card?.name ?? a.entry.cardId).localeCompare(b.card?.name ?? b.entry.cardId) ||
            a.entry.cardId.localeCompare(b.entry.cardId),
        ),
    [builder.entries, builder.catalogue],
  );

  const { summary } = builder;

  return (
    <div className="builder">
      <header className="builder__bar">
        <button type="button" className="btn" onClick={onExit}>
          Back
        </button>
        <input
          className="builder__name"
          value={builder.name}
          onChange={(e) => builder.setName(e.target.value)}
          aria-label="Deck name"
        />
        <span className={summary.legal ? 'tally tally--legal' : 'tally'}>
          {summary.size}/{DECK_SIZE}
        </span>
        <span
          className={summary.mercenaries >= MIN_MERCENARIES ? 'tally tally--legal' : 'tally'}
          title="Mercenaries"
        >
          ⚔ {summary.mercenaries}/{MIN_MERCENARIES}
        </span>
        <button
          type="button"
          className="btn btn--primary"
          disabled={builder.saving || !builder.dirty || !builder.storageAvailable}
          onClick={() => void builder.save()}
        >
          {builder.saving ? 'Saving…' : 'Save'}
        </button>
      </header>

      {builder.error && <p className="error">{builder.error}</p>}
      {!builder.storageAvailable && (
        <p className="error">
          No database connected, so decks cannot be saved. Building still works.
        </p>
      )}

      <div className="builder__body">
        <section className="builder__cards">
          <div className="filters">
            <select value={set} onChange={(e) => setSet(e.target.value)} aria-label="Set">
              <option value="all">All sets</option>
              {sets.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
            <select
              value={colour}
              onChange={(e) => setColour(e.target.value as ColourFilter)}
              aria-label="Colour"
            >
              <option value="all">All colours</option>
              <option value="white">White</option>
              <option value="green">Green</option>
              <option value="black">Black</option>
              <option value="red">Red</option>
            </select>
            <label className="filters__toggle">
              <input
                type="checkbox"
                checked={mercenariesOnly}
                onChange={(e) => setMercenariesOnly(e.target.checked)}
              />
              Mercenaries
            </label>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name or number"
              aria-label="Search by card number"
            />
            <span className="filters__count">{visible.length} cards</span>
          </div>

          {builder.loading ? (
            <p className="muted">Loading cards…</p>
          ) : (
            <div className="grid">
              {visible.map((card) => (
                <CardCell
                  key={card.id}
                  card={card}
                  count={builder.quantityOf(card.id)}
                  canAdd={builder.canAdd(card.id)}
                  onAdd={() => builder.add(card.id)}
                  onRemove={() => builder.remove(card.id)}
                  onInspect={() => setInspecting(card.id)}
                />
              ))}
            </div>
          )}
        </section>

        <aside className="builder__deck">
          <div className="builder__decklist">
            <h2>Deck</h2>
            {chosen.length === 0 ? (
              <p className="muted">No cards yet. Use + on a card to add it.</p>
            ) : (
              <ul className="decklist">
                {chosen.map(({ entry, card }) => {
                  // The printed name, which is how anybody thinks about a
                  // deck — "three Guts", not "three BK1-011". The number is
                  // kept on the title, because it is still the thing to quote
                  // when comparing against a printed list, and it is the
                  // fallback for a card whose name never came off the scan.
                  const label = card?.name ?? entry.cardId;
                  return (
                    <li key={entry.cardId} title={entry.cardId}>
                      <button
                        type="button"
                        className="decklist__minus"
                        onClick={() => builder.remove(entry.cardId)}
                        aria-label={`Remove one ${label}`}
                      >
                        −
                      </button>
                      <span className="decklist__count">{entry.quantity}</span>
                      <span className={`swatch swatch--${card?.color ?? 'white'}`} />
                      <button
                        type="button"
                        className="decklist__id"
                        onClick={() => setInspecting(entry.cardId)}
                        title={`Read ${label} (${entry.cardId})`}
                      >
                        {label}
                      </button>
                      {card?.mercenary && <span className="decklist__merc">merc</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="builder__status">
            {summary.legal ? (
              <p className="legal">Legal deck</p>
            ) : (
              <ul className="problems">
                {summary.errors.map((problem) => (
                  <li key={`${problem.code}-${problem.cardId ?? ''}`}>{problem.message}</li>
                ))}
              </ul>
            )}
            <button type="button" className="btn" onClick={builder.clear}>
              Clear
            </button>
          </div>

          <div className="builder__saved">
            <h2>Saved decks</h2>
            <button type="button" className="btn" onClick={builder.newDeck}>
              New deck
            </button>
            <ul className="decks">
              {builder.decks.map((deck) => (
                <li key={deck.id}>
                  <button
                    type="button"
                    className="decks__open"
                    onClick={() => builder.load(deck.id)}
                  >
                    {deck.name}
                    {deck.precon && <span className="decks__tag">precon</span>}
                    <span className={deck.summary.legal ? 'decks__ok' : 'decks__bad'}>
                      {deck.summary.size}
                    </span>
                  </button>
                  {!deck.precon && (
                    <button
                      type="button"
                      className="decks__delete"
                      onClick={() => void builder.destroy(deck.id)}
                      aria-label={`Delete ${deck.name}`}
                    >
                      ✕
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>

      {/* The same reader the table uses, so a card looks and reads the same
       * whether it is being chosen or played. */}
      {inspecting && <Inspect defId={inspecting} onClose={() => setInspecting(null)} />}
    </div>
  );
}

function CardCell({
  card,
  count,
  canAdd,
  onAdd,
  onRemove,
  onInspect,
}: {
  card: CatalogueCard;
  count: number;
  canAdd: boolean;
  onAdd: () => void;
  onRemove: () => void;
  onInspect: () => void;
}): JSX.Element {
  // The printed name where there is one. A card whose name never came off the
  // scan falls back to its number, which is at least a handle — see
  // `Docs/CardData.md`.
  const label = card.name ?? card.id;

  return (
    <div className={count > 0 ? 'cell cell--chosen' : 'cell'}>
      {/* Clicking the art reads the card. Building a deck means comparing
       * cards you cannot make out at this size, and the art was previously an
       * Add button — so the one gesture everybody tries first silently
       * changed the deck instead of answering the question. Adding and
       * removing are the explicit +/− below. */}
      <button
        type="button"
        className="cell__art"
        onClick={onInspect}
        title={`Read ${label}`}
        aria-label={`Read ${label}`}
      >
        <img src={`${CARD_ROOT}/${card.image}`} alt={label} loading="lazy" />
        {count > 0 && <span className="cell__count">{count}</span>}
      </button>
      <div className="cell__foot">
        <span className={`swatch swatch--${card.color ?? 'white'}`} />
        <span className="cell__id" title={card.id}>
          {label}
        </span>
        {/* Both buttons are always present, so the row never reflows as the
         * count changes and the target does not move under the pointer while
         * clicking through copies. Minus is merely disabled at zero. */}
        <span className="cell__spin">
          <button
            type="button"
            className="cell__minus"
            onClick={onRemove}
            disabled={count === 0}
            aria-label={`Remove one ${label}`}
            title={count === 0 ? 'None in the deck' : `Remove one ${label}`}
          >
            −
          </button>
          <button
            type="button"
            className="cell__plus"
            onClick={onAdd}
            disabled={!canAdd}
            aria-label={`Add one ${label}`}
            title={canAdd ? `Add one ${label}` : 'Copy limit reached'}
          >
            +
          </button>
        </span>
      </div>
    </div>
  );
}
