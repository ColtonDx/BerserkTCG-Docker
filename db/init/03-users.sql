-- Accounts. DesignNotes 1.
--
-- Runs after the card data, on first initialisation of an empty data
-- directory. `docker compose down -v` to reinitialise.

BEGIN;

CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Lowercased on the way in so logins are case-insensitive but the name a
    -- player typed is still shown back to them.
    username      text        NOT NULL,
    username_key  text        NOT NULL UNIQUE,
    -- scrypt, stored as `scrypt$<N>$<r>$<p>$<salt>$<hash>`; never a raw password.
    password_hash text        NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz,

    CONSTRAINT users_username_length CHECK (char_length(username) BETWEEN 3 AND 24),
    CONSTRAINT users_username_key_matches CHECK (username_key = lower(username))
);

-- Decks belonged to a browser-generated id before accounts existed. New decks
-- reference a user; the column stays text so existing rows survive the change.
ALTER TABLE decks ADD COLUMN user_id uuid REFERENCES users (id) ON DELETE CASCADE;
CREATE INDEX decks_user_idx ON decks (user_id);

COMMIT;

-- A player's badge on the table. Stored as a card number (`BK1-011`), because
-- the game already ships 448 pieces of art and serves them: a player picks a
-- character they play rather than an avatar from a set somebody has to draw.
-- Null means no choice made, and the badge falls back to their initial.
ALTER TABLE users ADD COLUMN IF NOT EXISTS icon text REFERENCES cards (id);

-- An operator, who can reset another player's password. There is no recovery
-- email on this server, so this is the way back in for someone locked out.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;
