-- Berserk TCG schema.
--
-- Runs once, the first time the Postgres container initialises an empty data
-- directory (files in /docker-entrypoint-initdb.d are executed in name order).
-- To re-run it after a change, drop the volume: `docker compose down -v`.

BEGIN;

-- ---------------------------------------------------------------- card data

CREATE TYPE card_color AS ENUM ('white', 'green', 'black', 'red');

-- Rules.md §3. The type line says which of the two a card is; for an Effect
-- it also says Normal or Eternal, with Quick as a separate marker beside it.
-- Quick is therefore a flag on a Normal, not a kind of its own.
CREATE TYPE card_kind AS ENUM ('character', 'effect');
CREATE TYPE effect_duration AS ENUM ('normal', 'eternal');

CREATE TABLE cards (
    -- Printed card number, e.g. 'BK1-007'. The stable key for a card.
    id           text PRIMARY KEY,
    set_code     text        NOT NULL,
    number       integer     NOT NULL,
    image        text        NOT NULL,

    color        card_color  NOT NULL,
    -- The card named "Mercenary": four per set, one per colour. A deck needs
    -- at least ten of these and may hold any number. Docs/Deckbuilding.md.
    mercenary    boolean     NOT NULL DEFAULT false,

    -- Printed on the card. Null until captured — never a guess, because deck
    -- legality and play both key off these. See Docs/CardData.md.
    name         text,
    cost         text,
    level        integer,
    type         card_kind,
    -- Null for a character. Decides whether an opened card stays on the table
    -- or resolves and goes to the Trash.
    duration     effect_duration,
    is_quick     boolean     NOT NULL DEFAULT false,
    is_character boolean,
    is_unique    boolean,
    power        integer,
    hp           integer,
    range        integer,
    movement     integer,
    effect       text,

    UNIQUE (set_code, number),
    CONSTRAINT cards_number_positive CHECK (number > 0),
    CONSTRAINT cards_level_sane CHECK (level IS NULL OR level BETWEEN 0 AND 9),
    CONSTRAINT cards_power_sane CHECK (power IS NULL OR power BETWEEN 0 AND 99),
    CONSTRAINT cards_hp_sane CHECK (hp IS NULL OR hp BETWEEN 0 AND 99),
    CONSTRAINT cards_range_sane CHECK (range IS NULL OR range BETWEEN 0 AND 9),
    CONSTRAINT cards_movement_sane CHECK (movement IS NULL OR movement BETWEEN 0 AND 9),
    -- Only an Effect has a duration, and only a Normal one can be Quick.
    CONSTRAINT cards_duration_matches_kind CHECK (
        (type = 'character' AND duration IS NULL AND NOT is_quick)
        OR (type = 'effect' AND duration IS NOT NULL AND (NOT is_quick OR duration = 'normal'))
        OR type IS NULL
    ),
    -- Only Character cards carry combat stats; Effect cards must not.
    CONSTRAINT cards_stats_match_kind CHECK (
        is_character IS DISTINCT FROM false
        OR (power IS NULL AND hp IS NULL AND range IS NULL AND movement IS NULL)
    )
);

CREATE INDEX cards_set_idx ON cards (set_code, number);
CREATE INDEX cards_color_idx ON cards (color);
CREATE INDEX cards_mercenary_idx ON cards (mercenary) WHERE mercenary;

-- ------------------------------------------------------------------- decks

CREATE TABLE decks (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner      text        NOT NULL,
    name       text        NOT NULL,
    -- A precon ships with the game; a player deck belongs to its owner.
    precon     boolean     NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deck_cards (
    deck_id  uuid    NOT NULL REFERENCES decks (id) ON DELETE CASCADE,
    card_id  text    NOT NULL REFERENCES cards (id),
    -- Docs/Deckbuilding.md caps a card at 3 copies; mercenaries are exempt and
    -- unlimited, so the cap is enforced in the engine where that exemption is
    -- known. This only rejects nonsense.
    quantity integer NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (deck_id, card_id)
);

CREATE INDEX deck_cards_card_idx ON deck_cards (card_id);

-- A deck's size, for checking the 45-card rule.
CREATE VIEW deck_sizes AS
SELECT d.id AS deck_id,
       d.name,
       COALESCE(SUM(dc.quantity), 0)::integer AS cards,
       COALESCE(SUM(dc.quantity) FILTER (WHERE c.mercenary), 0)::integer AS mercenaries
FROM decks d
LEFT JOIN deck_cards dc ON dc.deck_id = d.id
LEFT JOIN cards c ON c.id = dc.card_id
GROUP BY d.id, d.name;

COMMIT;
