import { DECK_SIZE, MAX_COPIES, MIN_MERCENARIES, type CatalogueCard } from '@berserk/engine';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { useDeckBuilder } from '../state/useDeckBuilder.js';
import { implementedIn, useCardNames } from '../state/useCardNames.js';
import { CardImage } from './CardImage.js';
import { Inspect } from './Inspect.js';

/**
 * The deck builder: browse all 448 cards, build a 45-card deck, see legality
 * update as you go.
 *
 * Laid out the way card games have settled on: the collection on the left
 * under a search box and a row of filter chips, the card under the pointer
 * held up large in the middle so nothing has to be opened to be read, and the
 * deck on the right as a list grouped by type and sorted by Level, with its
 * curve and its colours above it. Clicking a card adds it and right-clicking
 * takes it back; the deck's rows do the reverse. A magnifier on each card
 * still opens the full reader, for a finger that cannot hover.
 *
 * The rules shown here come from the engine, not from anything reimplemented
 * in the UI — the same `summariseDeck` the server calls. That keeps the
 * feedback honest, and means a rules change lands in both places at once.
 */

const CARD_ROOT = import.meta.env['VITE_SERVER_URL'] ?? '';

type Colour = 'white' | 'green' | 'black' | 'red';
const COLOURS: readonly Colour[] = ['white', 'green', 'black', 'red'];
const COLOUR_LABEL: Record<Colour, string> = {
  white: 'White',
  green: 'Green',
  black: 'Black',
  red: 'Red',
};

type Kind = 'character' | 'effect';
/** Levels offered as chips; the last one gathers everything above it. */
const LEVELS = [0, 1, 2, 3, 4, 5] as const;
const TOP_LEVEL = 5;

type Sort = 'level' | 'name' | 'colour' | 'cost' | 'number';
const SORTS: readonly { value: Sort; label: string }[] = [
  { value: 'level', label: 'Level' },
  { value: 'cost', label: 'Cost' },
  { value: 'name', label: 'Name' },
  { value: 'colour', label: 'Colour' },
  { value: 'number', label: 'Number' },
];

interface Props {
  readonly onExit: () => void;
}

export function DeckBuilder({ onExit }: Props): JSX.Element {
  const builder = useDeckBuilder();
  useCardNames();

  // ------------------------------------------------------------ filters
  const [search, setSearch] = useState('');
  const [set, setSet] = useState('all');
  const [colours, setColours] = useState<ReadonlySet<Colour>>(new Set());
  const [kinds, setKinds] = useState<ReadonlySet<Kind>>(new Set());
  const [levels, setLevels] = useState<ReadonlySet<number>>(new Set());
  const [quickOnly, setQuickOnly] = useState(false);
  const [mercenariesOnly, setMercenariesOnly] = useState(false);
  const [inDeckOnly, setInDeckOnly] = useState(false);
  const [sort, setSort] = useState<Sort>('level');
  // Folded away by default: the card grid is what the screen is for, and
  // five rows of chips leave it a third of the height on a narrow window.
  const [filtersOpen, setFiltersOpen] = useState(false);

  // The card under the pointer, held up in the preview. It stays once the
  // pointer leaves — a preview that blinks away the moment you move to click
  // is a preview you cannot act on.
  const [previewId, setPreviewId] = useState<string | null>(null);
  // The full reader, for touch and for reading at leisure.
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [decksOpen, setDecksOpen] = useState(false);

  const searchBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const typing =
        event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      if (event.key === '/' && !typing) {
        event.preventDefault();
        searchBox.current?.focus();
      }
      if (event.key === 'Escape' && event.target === searchBox.current) {
        setSearch('');
        searchBox.current?.blur();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const byId = useMemo(
    () => new Map(builder.catalogue.map((card) => [card.id, card])),
    [builder.catalogue],
  );
  const sets = useMemo(
    () => [...new Set(builder.catalogue.map((card) => card.set))].sort(),
    [builder.catalogue],
  );

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matches = builder.catalogue.filter((card) => {
      if (set !== 'all' && card.set !== set) return false;
      if (colours.size > 0 && (card.color === null || !colours.has(card.color))) return false;
      if (kinds.size > 0 && (card.type === null || !kinds.has(card.type))) return false;
      if (levels.size > 0) {
        const level = card.level === null ? -1 : Math.min(card.level, TOP_LEVEL);
        if (!levels.has(level)) return false;
      }
      if (quickOnly && !card.quick) return false;
      if (mercenariesOnly && !card.mercenary) return false;
      if (inDeckOnly && builder.quantityOf(card.id) === 0) return false;
      // Name, number or rules text: "draw" finds every card that draws.
      if (
        needle &&
        !card.id.toLowerCase().includes(needle) &&
        !(card.name ?? '').toLowerCase().includes(needle) &&
        !(card.effect ?? '').toLowerCase().includes(needle) &&
        !card.subtypes.some((token) => token.includes(needle))
      ) {
        return false;
      }
      return true;
    });
    return matches.sort(comparator(sort));
  }, [
    builder.catalogue,
    builder.quantityOf,
    set,
    colours,
    kinds,
    levels,
    quickOnly,
    mercenariesOnly,
    inDeckOnly,
    search,
    sort,
  ]);

  const filtering =
    search !== '' ||
    set !== 'all' ||
    colours.size > 0 ||
    kinds.size > 0 ||
    levels.size > 0 ||
    quickOnly ||
    mercenariesOnly ||
    inDeckOnly;

  const clearFilters = (): void => {
    setSearch('');
    setSet('all');
    setColours(new Set());
    setKinds(new Set());
    setLevels(new Set());
    setQuickOnly(false);
    setMercenariesOnly(false);
    setInDeckOnly(false);
  };

  // ------------------------------------------------------------ the deck
  const { summary } = builder;
  const rows = useMemo(
    () =>
      builder.entries
        .map((entry) => ({ entry, card: byId.get(entry.cardId) }))
        .sort((a, b) =>
          comparator('level')(a.card ?? ghost(a.entry.cardId), b.card ?? ghost(b.entry.cardId)),
        ),
    [builder.entries, byId],
  );
  const characters = rows.filter(({ card }) => card?.type !== 'effect');
  const effects = rows.filter(({ card }) => card?.type === 'effect');
  const stats = useMemo(() => tally(rows), [rows]);

  const preview = previewId ? (byId.get(previewId) ?? null) : null;

  /** Guards leaving or replacing an unsaved deck. */
  const confirmDiscard = (): boolean =>
    !builder.dirty || window.confirm('Discard the unsaved changes to this deck?');

  return (
    <div className="db">
      <header className="db__bar">
        <button
          type="button"
          className="btn"
          onClick={() => {
            if (confirmDiscard()) onExit();
          }}
        >
          Back
        </button>

        <div className="db__title">
          <input
            className="db__name"
            value={builder.name}
            onChange={(e) => builder.setName(e.target.value)}
            aria-label="Deck name"
            spellCheck={false}
          />
          {builder.dirty && (
            <span className="db__dirty" title="Unsaved changes">
              ●
            </span>
          )}
        </div>

        <div className="db__decks">
          <button
            type="button"
            className={
              decksOpen ? 'btn db__decks-toggle db__decks-toggle--open' : 'btn db__decks-toggle'
            }
            onClick={() => setDecksOpen((open) => !open)}
            aria-expanded={decksOpen}
          >
            Decks ▾
          </button>
          {decksOpen && (
            <DecksMenu
              builder={builder}
              onClose={() => setDecksOpen(false)}
              confirmDiscard={confirmDiscard}
            />
          )}
        </div>

        <Tally summary={summary} />

        <button
          type="button"
          className="btn btn--primary"
          disabled={builder.saving || !builder.dirty || !builder.storageAvailable}
          onClick={() => void builder.save()}
          title={builder.storageAvailable ? undefined : 'No database connected'}
        >
          {builder.saving ? 'Saving…' : 'Save'}
        </button>
      </header>

      {builder.error && <p className="error db__error">{builder.error}</p>}
      {!builder.storageAvailable && (
        <p className="error db__error">
          No database connected, so decks cannot be saved. Building still works.
        </p>
      )}

      <div className="db__body">
        {/* ------------------------------------------------ the collection */}
        <section className="db__browse" aria-label="Collection">
          <div className="db__tools">
            <div className="db__search">
              <input
                ref={searchBox}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, text or number  ( / )"
                aria-label="Search cards"
                spellCheck={false}
              />
              {search && (
                <button
                  type="button"
                  className="db__search-clear"
                  onClick={() => setSearch('')}
                  aria-label="Clear search"
                >
                  ✕
                </button>
              )}
            </div>

            <button
              type="button"
              className={
                filtersOpen ? 'db__filters-toggle db__filters-toggle--open' : 'db__filters-toggle'
              }
              onClick={() => setFiltersOpen((open) => !open)}
              aria-expanded={filtersOpen}
            >
              Filters{filtering ? ' •' : ''}
            </button>

            <span className="db__count">
              {visible.length} of {builder.catalogue.length}
              {filtering && (
                <button type="button" className="db__reset" onClick={clearFilters}>
                  reset
                </button>
              )}
            </span>
          </div>

          {/* The chip rows fold away, because five groups of them wrap to
           * several rows on a narrow window and the card grid is what the
           * screen is actually for. */}
          <div className={filtersOpen ? 'db__filters db__filters--open' : 'db__filters'}>
            <div className="db__chips" role="group" aria-label="Colour">
              {COLOURS.map((colour) => (
                <Chip
                  key={colour}
                  on={colours.has(colour)}
                  onClick={() => setColours(toggled(colours, colour))}
                  title={COLOUR_LABEL[colour]}
                  className={`chip--${colour}`}
                >
                  <span className={`swatch swatch--${colour}`} />
                </Chip>
              ))}
            </div>

            <div className="db__chips" role="group" aria-label="Type">
              <Chip
                on={kinds.has('character')}
                onClick={() => setKinds(toggled(kinds, 'character'))}
              >
                Character
              </Chip>
              <Chip on={kinds.has('effect')} onClick={() => setKinds(toggled(kinds, 'effect'))}>
                Effect
              </Chip>
              <Chip
                on={quickOnly}
                onClick={() => setQuickOnly((on) => !on)}
                title="Quick cards only"
              >
                Quick
              </Chip>
            </div>

            <div className="db__chips db__chips--levels" role="group" aria-label="Level">
              {LEVELS.map((level) => (
                <Chip
                  key={level}
                  on={levels.has(level)}
                  onClick={() => setLevels(toggled(levels, level))}
                  title={`Level ${level === TOP_LEVEL ? `${level}+` : level}`}
                >
                  {level === TOP_LEVEL ? `${level}+` : level}
                </Chip>
              ))}
            </div>

            <div className="db__chips" role="group" aria-label="More">
              <Chip
                on={mercenariesOnly}
                onClick={() => setMercenariesOnly((on) => !on)}
                title="The Mercenary cards a deck needs ten of"
              >
                ⚔ Mercenaries
              </Chip>
              <Chip on={inDeckOnly} onClick={() => setInDeckOnly((on) => !on)}>
                In deck
              </Chip>
            </div>

            <select value={set} onChange={(e) => setSet(e.target.value)} aria-label="Set">
              <option value="all">All sets</option>
              {sets.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>

            <label className="db__sort">
              <span>Sort</span>
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                {SORTS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {builder.loading ? (
            <p className="muted">Loading cards…</p>
          ) : visible.length === 0 ? (
            <div className="db__empty">
              <p className="muted">No cards match.</p>
              <button type="button" className="btn" onClick={clearFilters}>
                Reset filters
              </button>
            </div>
          ) : (
            <div className="db__grid">
              {visible.map((card) => (
                <CardCell
                  key={card.id}
                  card={card}
                  count={builder.quantityOf(card.id)}
                  canAdd={builder.canAdd(card.id)}
                  onAdd={() => builder.add(card.id)}
                  onRemove={() => builder.remove(card.id)}
                  onHover={() => setPreviewId(card.id)}
                  onInspect={() => setInspecting(card.id)}
                />
              ))}
            </div>
          )}
        </section>

        {/* ------------------------------------------------- the preview */}
        <aside className="db__preview" aria-label="Card preview">
          {preview ? (
            <Preview
              card={preview}
              count={builder.quantityOf(preview.id)}
              onInspect={() => setInspecting(preview.id)}
            />
          ) : (
            <div className="db__preview-empty">
              <div className="db__preview-back" />
              <p className="muted">Hover a card to read it here.</p>
              <p className="db__howto">
                <b>Click</b> a card to add it · <b>right-click</b> to take one out
              </p>
            </div>
          )}
        </aside>

        {/* ----------------------------------------------------- the deck */}
        <aside className="db__deck" aria-label="Deck">
          <Curve stats={stats} />

          <div className="db__list">
            {rows.length === 0 ? (
              <div className="db__empty">
                <p className="muted">No cards yet.</p>
                <p className="db__howto">
                  Click a card in the collection to add it. A deck is {DECK_SIZE} cards with at
                  least {MIN_MERCENARIES} Mercenaries; any other card up to {MAX_COPIES} copies.
                </p>
              </div>
            ) : (
              <>
                <Group
                  title="Characters"
                  rows={characters}
                  builder={builder}
                  onHover={setPreviewId}
                />
                <Group title="Effects" rows={effects} builder={builder} onHover={setPreviewId} />
              </>
            )}
          </div>

          <div className="db__foot">
            {summary.legal ? (
              <p className="db__legal">✓ Legal — ready to play</p>
            ) : (
              <ul className="db__problems">
                {summary.errors.map((problem) => (
                  <li key={`${problem.code}-${problem.cardId ?? ''}`}>{problem.message}</li>
                ))}
              </ul>
            )}
            {rows.length > 0 && (
              <button
                type="button"
                className="btn db__clear"
                onClick={() => {
                  if (window.confirm('Remove every card from this deck?')) builder.clear();
                }}
              >
                Clear deck
              </button>
            )}
          </div>
        </aside>
      </div>

      {/* The same reader the table uses, so a card looks and reads the same
       * whether it is being chosen or played. */}
      {inspecting && <Inspect defId={inspecting} onClose={() => setInspecting(null)} />}
    </div>
  );
}

/* ----------------------------------------------------------------- pieces */

function Chip({
  on,
  onClick,
  title,
  className,
  children,
}: {
  on: boolean;
  onClick: () => void;
  title?: string;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  const classes = ['chip'];
  if (on) classes.push('chip--on');
  if (className) classes.push(className);
  return (
    <button
      type="button"
      className={classes.join(' ')}
      onClick={onClick}
      aria-pressed={on}
      {...(title ? { title } : {})}
    >
      {children}
    </button>
  );
}

/** Deck size and Mercenaries: the two numbers that decide legality. */
function Tally({
  summary,
}: {
  summary: ReturnType<typeof useDeckBuilder>['summary'];
}): JSX.Element {
  const full = Math.min(1, summary.size / DECK_SIZE);
  const over = summary.size > DECK_SIZE;
  return (
    <div className="db__tally">
      <div
        className={
          over
            ? 'db__size db__size--over'
            : summary.size === DECK_SIZE
              ? 'db__size db__size--full'
              : 'db__size'
        }
        title="Cards in the deck"
      >
        <span className="db__size-bar" style={{ width: `${full * 100}%` }} />
        <span className="db__size-text">
          {summary.size}
          <span className="db__size-of">/{DECK_SIZE}</span>
        </span>
      </div>
      <span
        className={summary.mercenaries >= MIN_MERCENARIES ? 'db__mercs db__mercs--ok' : 'db__mercs'}
        title={`Mercenaries — at least ${MIN_MERCENARIES} needed`}
      >
        ⚔ {summary.mercenaries}
        <span className="db__size-of">/{MIN_MERCENARIES}</span>
      </span>
    </div>
  );
}

function CardCell({
  card,
  count,
  canAdd,
  onAdd,
  onRemove,
  onHover,
  onInspect,
}: {
  card: CatalogueCard;
  count: number;
  canAdd: boolean;
  onAdd: () => void;
  onRemove: () => void;
  onHover: () => void;
  onInspect: () => void;
}): JSX.Element {
  // The printed name where there is one. A card whose name never came off the
  // scan falls back to its number, which is at least a handle — see
  // `Docs/CardData.md`.
  const label = card.name ?? card.id;
  const classes = ['dbcard'];
  if (count > 0) classes.push('dbcard--in');
  if (!canAdd) classes.push('dbcard--max');

  const remove = (event: MouseEvent): void => {
    event.preventDefault();
    onRemove();
  };

  return (
    <div className={classes.join(' ')} onMouseEnter={onHover} onFocus={onHover}>
      {/* Click adds, right-click removes — the convention every card game
       * has arrived at. Reading happens in the preview beside the grid, or
       * through the magnifier for a finger. */}
      <button
        type="button"
        className="dbcard__art"
        onClick={onAdd}
        onContextMenu={remove}
        disabled={!canAdd && count === 0}
        title={canAdd ? `Add ${label}` : `${label} — copy limit reached`}
        aria-label={`Add one ${label}`}
      >
        <img src={`${CARD_ROOT}/${card.image}`} alt="" loading="lazy" draggable={false} />
        {card.level !== null && <span className="dbcard__level">{card.level}</span>}
        {count > 0 && (
          <span className="dbcard__count">
            {count}
            {!card.mercenary && <span className="dbcard__count-of">/{MAX_COPIES}</span>}
          </span>
        )}
      </button>
      <div className="dbcard__foot">
        <span className={`swatch swatch--${card.color ?? 'white'}`} />
        <span className="dbcard__name" title={`${label} · ${card.id}`}>
          {label}
        </span>
        {card.cost && <span className="dbcard__cost">{card.cost}</span>}
        <button
          type="button"
          className="dbcard__look"
          onClick={onInspect}
          aria-label={`Read ${label}`}
          title="Read"
        >
          🔍
        </button>
      </div>
    </div>
  );
}

/** The card under the pointer, at reading size, with what is printed on it. */
function Preview({
  card,
  count,
  onInspect,
}: {
  card: CatalogueCard;
  count: number;
  onInspect: () => void;
}): JSX.Element {
  const label = card.name ?? card.id;
  const line = [
    card.type === 'effect'
      ? card.duration === 'eternal'
        ? 'Eternal Effect'
        : 'Normal Effect'
      : 'Character',
    card.quick ? 'Quick' : null,
    card.unique ? 'Unique' : null,
    ...card.subtypes,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
  return (
    <div className="db__preview-card">
      <button type="button" className="db__preview-art" onClick={onInspect} title="Read in full">
        <CardImage defId={card.id} />
      </button>
      <div className="db__preview-head">
        <span className="db__preview-name">{label}</span>
        <span className="db__preview-id">{card.id}</span>
      </div>
      <p className="db__preview-line">{line}</p>
      <dl className="db__preview-stats">
        <div>
          <dt>Level</dt>
          <dd>{card.level ?? '—'}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>{card.cost ?? '—'}</dd>
        </div>
        {card.type !== 'effect' && (
          <>
            <div>
              <dt>Power</dt>
              <dd>{card.power ?? '—'}</dd>
            </div>
            <div>
              <dt>HP</dt>
              <dd>{card.hp ?? '—'}</dd>
            </div>
            <div>
              <dt>Range</dt>
              <dd>{card.range ?? '—'}</dd>
            </div>
            <div>
              <dt>Move</dt>
              <dd>{card.movement ?? '—'}</dd>
            </div>
          </>
        )}
      </dl>
      {card.effect && (
        <p
          className={
            implementedIn(card.id) ? 'db__preview-text' : 'db__preview-text db__preview-text--inert'
          }
        >
          {card.effect}
          {/* Most of the set has no behaviour written yet (Rules.md §13).
           * Saying so beats building a deck around an ability that will not
           * happen. */}
          {!implementedIn(card.id) && <span className="db__preview-pending">not yet in play</span>}
        </p>
      )}
      <p className="db__preview-count">
        {count === 0
          ? 'Not in the deck'
          : `${count} in the deck${card.mercenary ? '' : ` of ${MAX_COPIES}`}`}
      </p>
    </div>
  );
}

/** The deck's shape at a glance: how many cards at each Level, and of each colour. */
function Curve({ stats }: { stats: Stats }): JSX.Element {
  const peak = Math.max(1, ...stats.levels);
  return (
    <div className="db__shape">
      <div className="db__curve" role="img" aria-label="Level curve">
        {stats.levels.map((n, level) => (
          <div key={level} className="db__bar" title={`Level ${labelLevel(level)}: ${n}`}>
            <span className="db__bar-n">{n > 0 ? n : ''}</span>
            <span className="db__bar-fill" style={{ height: `${(n / peak) * 100}%` }} />
            <span className="db__bar-label">{labelLevel(level)}</span>
          </div>
        ))}
      </div>
      <div className="db__mix">
        <div className="db__colours" title="Cards of each colour">
          {COLOURS.map((colour) => {
            const n = stats.colours[colour];
            if (n === 0) return null;
            return (
              <span
                key={colour}
                className={`db__colour db__colour--${colour}`}
                style={{ flex: n }}
                title={`${COLOUR_LABEL[colour]}: ${n}`}
              >
                {n}
              </span>
            );
          })}
        </div>
        <span className="db__kinds">
          {stats.characters} characters · {stats.effects} effects
          {stats.quick > 0 ? ` · ${stats.quick} quick` : ''}
        </span>
      </div>
    </div>
  );
}

function Group({
  title,
  rows,
  builder,
  onHover,
}: {
  title: string;
  rows: readonly Row[];
  builder: ReturnType<typeof useDeckBuilder>;
  onHover: (id: string) => void;
}): JSX.Element | null {
  if (rows.length === 0) return null;
  const total = rows.reduce((sum, { entry }) => sum + entry.quantity, 0);
  return (
    <section className="db__group">
      <h3 className="db__group-title">
        {title} <span className="db__group-n">{total}</span>
      </h3>
      <ul className="db__rows">
        {rows.map(({ entry, card }) => {
          // The printed name, which is how anybody thinks about a deck —
          // "three Guts", not "three BK1-011". The number stays on the title.
          const label = card?.name ?? entry.cardId;
          return (
            <li
              key={entry.cardId}
              className="db__row"
              title={`${label} · ${entry.cardId}`}
              onMouseEnter={() => onHover(entry.cardId)}
              // The reverse of the collection: click takes one out,
              // right-click puts one back.
              onClick={() => builder.remove(entry.cardId)}
              onContextMenu={(event) => {
                event.preventDefault();
                builder.add(entry.cardId);
              }}
            >
              <span className={`db__row-colour db__row-colour--${card?.color ?? 'white'}`} />
              <span className="db__row-level">{card?.level ?? '·'}</span>
              <span className="db__row-name">
                {label}
                {card?.mercenary && <span className="db__row-merc">⚔</span>}
              </span>
              {card?.cost && <span className="db__row-cost">{card.cost}</span>}
              <span className="db__row-n">×{entry.quantity}</span>
              <span className="db__row-spin" onClick={(event) => event.stopPropagation()}>
                <button
                  type="button"
                  onClick={() => builder.remove(entry.cardId)}
                  aria-label={`Remove one ${label}`}
                >
                  −
                </button>
                <button
                  type="button"
                  onClick={() => builder.add(entry.cardId)}
                  disabled={!builder.canAdd(entry.cardId)}
                  aria-label={`Add one ${label}`}
                >
                  +
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Saved decks and the precons, in a panel under the Decks button. */
function DecksMenu({
  builder,
  onClose,
  confirmDiscard,
}: {
  builder: ReturnType<typeof useDeckBuilder>;
  onClose: () => void;
  confirmDiscard: () => boolean;
}): JSX.Element {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (event: PointerEvent): void => {
      if (panel.current && !panel.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const mine = builder.decks.filter((deck) => !deck.precon);
  const precons = builder.decks.filter((deck) => deck.precon);

  return (
    <div className="db__menu" ref={panel} role="menu">
      <div className="db__menu-actions">
        <button
          type="button"
          className="btn"
          onClick={() => {
            if (!confirmDiscard()) return;
            builder.newDeck();
            onClose();
          }}
        >
          New deck
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            builder.duplicate();
            onClose();
          }}
          disabled={builder.entries.length === 0}
        >
          Duplicate
        </button>
      </div>

      <h3 className="db__menu-title">Your decks</h3>
      {mine.length === 0 ? (
        <p className="muted db__menu-empty">Nothing saved yet.</p>
      ) : (
        <ul className="db__menu-list">
          {mine.map((deck) => (
            <li
              key={deck.id}
              className={
                deck.id === builder.deckId ? 'db__menu-row db__menu-row--on' : 'db__menu-row'
              }
            >
              <button
                type="button"
                className="db__menu-open"
                onClick={() => {
                  if (deck.id !== builder.deckId && !confirmDiscard()) return;
                  builder.load(deck.id);
                  onClose();
                }}
              >
                <span
                  className={deck.summary.legal ? 'db__menu-dot db__menu-dot--ok' : 'db__menu-dot'}
                />
                <span className="db__menu-name">{deck.name}</span>
                <span className="db__menu-size">{deck.summary.size}</span>
              </button>
              <button
                type="button"
                className="db__menu-delete"
                onClick={() => {
                  if (window.confirm(`Delete "${deck.name}"?`)) void builder.destroy(deck.id);
                }}
                aria-label={`Delete ${deck.name}`}
                title="Delete"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {precons.length > 0 && (
        <>
          <h3 className="db__menu-title">Starter decks</h3>
          <ul className="db__menu-list">
            {precons.map((deck) => (
              <li key={deck.id} className="db__menu-row">
                <button
                  type="button"
                  className="db__menu-open"
                  onClick={() => {
                    if (!confirmDiscard()) return;
                    builder.load(deck.id);
                    onClose();
                  }}
                  title="Open a copy to edit"
                >
                  <span className="db__menu-dot db__menu-dot--ok" />
                  <span className="db__menu-name">{deck.name}</span>
                  <span className="db__menu-size">copy</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- helpers */

interface Row {
  readonly entry: { readonly cardId: string; readonly quantity: number };
  readonly card: CatalogueCard | undefined;
}

interface Stats {
  /** Cards at each Level, index `TOP_LEVEL` gathering everything above. */
  readonly levels: readonly number[];
  readonly colours: Record<Colour, number>;
  readonly characters: number;
  readonly effects: number;
  readonly quick: number;
}

function tally(rows: readonly Row[]): Stats {
  const levels = Array.from({ length: TOP_LEVEL + 1 }, () => 0);
  const colours: Record<Colour, number> = { white: 0, green: 0, black: 0, red: 0 };
  let characters = 0;
  let effects = 0;
  let quick = 0;
  for (const { entry, card } of rows) {
    const n = entry.quantity;
    if (!card) continue;
    if (card.level !== null) {
      const at = Math.min(card.level, TOP_LEVEL);
      levels[at] = (levels[at] ?? 0) + n;
    }
    if (card.color) colours[card.color] += n;
    if (card.type === 'effect') effects += n;
    else characters += n;
    if (card.quick) quick += n;
  }
  return { levels, colours, characters, effects, quick };
}

const labelLevel = (level: number): string => (level === TOP_LEVEL ? `${level}+` : String(level));

function toggled<T>(current: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/** A row for a deck entry whose card is not in the catalogue, so it still sorts. */
const ghost = (id: string): CatalogueCard => ({
  id,
  set: '',
  number: 0,
  image: '',
  color: null,
  mercenary: false,
  name: null,
  cost: null,
  level: null,
  type: null,
  duration: null,
  quick: false,
  character: null,
  unique: null,
  power: null,
  hp: null,
  range: null,
  movement: null,
  effect: null,
  subtypes: [],
});

/** What a cost adds up to, for sorting: `1B` is two cards out of hand. */
function costTotal(cost: string | null): number {
  if (!cost) return 0;
  const generic = Number(/^\d+/.exec(cost)?.[0] ?? 0);
  const coloured = cost.replace(/^\d+/, '').length;
  return generic + coloured;
}

const COLOUR_ORDER: Record<string, number> = { white: 0, green: 1, black: 2, red: 3 };

const byName = (a: CatalogueCard, b: CatalogueCard): number =>
  (a.name ?? a.id).localeCompare(b.name ?? b.id) || a.id.localeCompare(b.id);
const byNumber = (a: CatalogueCard, b: CatalogueCard): number =>
  a.set.localeCompare(b.set) || a.number - b.number;
const byColour = (a: CatalogueCard, b: CatalogueCard): number =>
  (COLOUR_ORDER[a.color ?? ''] ?? 9) - (COLOUR_ORDER[b.color ?? ''] ?? 9);
const byLevel = (a: CatalogueCard, b: CatalogueCard): number => (a.level ?? 99) - (b.level ?? 99);

function comparator(sort: Sort): (a: CatalogueCard, b: CatalogueCard) => number {
  switch (sort) {
    case 'level':
      return (a, b) => byLevel(a, b) || byColour(a, b) || byName(a, b);
    case 'cost':
      return (a, b) => costTotal(a.cost) - costTotal(b.cost) || byLevel(a, b) || byName(a, b);
    case 'name':
      return byName;
    case 'colour':
      return (a, b) => byColour(a, b) || byLevel(a, b) || byName(a, b);
    case 'number':
      return byNumber;
  }
}
