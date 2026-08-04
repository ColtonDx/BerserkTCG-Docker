import { DECK_SIZE, MIN_MERCENARIES, type CatalogueCard } from '@berserk/engine';
import { useMemo, useState, type JSX } from 'react';
import { useDeckBuilder } from '../state/useDeckBuilder.js';

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
      if (needle && !card.id.toLowerCase().includes(needle)) return false;
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
        .sort((a, b) => a.entry.cardId.localeCompare(b.entry.cardId)),
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
              placeholder="Card number"
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
                />
              ))}
            </div>
          )}
        </section>

        <aside className="builder__deck">
          <div className="builder__decklist">
            <h2>Deck</h2>
            {chosen.length === 0 ? (
              <p className="muted">No cards yet. Click a card to add it.</p>
            ) : (
              <ul className="decklist">
                {chosen.map(({ entry, card }) => (
                  <li key={entry.cardId}>
                    <button
                      type="button"
                      className="decklist__minus"
                      onClick={() => builder.remove(entry.cardId)}
                      aria-label={`Remove ${entry.cardId}`}
                    >
                      −
                    </button>
                    <span className="decklist__count">{entry.quantity}</span>
                    <span className={`swatch swatch--${card?.color ?? 'white'}`} />
                    <span className="decklist__id">{entry.cardId}</span>
                    {card?.mercenary && <span className="decklist__merc">merc</span>}
                  </li>
                ))}
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
    </div>
  );
}

function CardCell({
  card,
  count,
  canAdd,
  onAdd,
  onRemove,
}: {
  card: CatalogueCard;
  count: number;
  canAdd: boolean;
  onAdd: () => void;
  onRemove: () => void;
}): JSX.Element {
  return (
    <div className={count > 0 ? 'cell cell--chosen' : 'cell'}>
      <button
        type="button"
        className="cell__art"
        onClick={onAdd}
        disabled={!canAdd}
        title={canAdd ? `Add ${card.id}` : 'Copy limit reached'}
      >
        <img src={`${CARD_ROOT}/${card.image}`} alt={card.id} loading="lazy" />
        {count > 0 && <span className="cell__count">{count}</span>}
      </button>
      <div className="cell__foot">
        <span className={`swatch swatch--${card.color ?? 'white'}`} />
        <span className="cell__id">{card.id}</span>
        {count > 0 && (
          <button type="button" className="cell__minus" onClick={onRemove} aria-label="Remove one">
            −
          </button>
        )}
      </div>
    </div>
  );
}
