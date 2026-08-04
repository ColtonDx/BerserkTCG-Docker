import { useEffect, useState, type JSX } from 'react';
import { CardImage } from './CardImage.js';
import { isMuted, setMuted, setVolume, volume } from '../net/sound.js';
import { nameOf, useCardNames } from '../state/useCardNames.js';
import { authHeaders, type Auth } from '../state/useAuth.js';

/**
 * Settings.
 *
 * Reachable from the main menu and from inside a match, because the thing
 * most likely to send someone here is the sound, and having to abandon a game
 * to turn it down is not a setting so much as a punishment.
 *
 * Three things live here: sound, the badge you are drawn as, and your
 * password. Sound is local to the browser; the other two belong to the
 * account and go to the server.
 */

const API = import.meta.env['VITE_SERVER_URL'] ?? '';

interface Props {
  readonly auth: Auth;
  readonly onClose: () => void;
}

export function Settings({ auth, onClose }: Props): JSX.Element {
  useCardNames();
  const [muted, setMutedState] = useState(isMuted);
  const [level, setLevel] = useState(volume);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="focus settings" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="focus__panel settings__panel">
        <h2 className="focus__title">Settings</h2>

        <section className="settings__group">
          <h3 className="settings__heading">Sound</h3>
          <label className="settings__row">
            <input
              type="checkbox"
              checked={!muted}
              onChange={(event) => {
                const on = event.target.checked;
                setMuted(!on);
                setMutedState(!on);
              }}
            />
            <span>Sound effects</span>
          </label>
          <label className="settings__row">
            <span className="settings__label">Volume</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(level * 100)}
              disabled={muted}
              onChange={(event) => {
                const next = Number(event.target.value) / 100;
                setVolume(next);
                setLevel(next);
              }}
            />
            <span className="settings__value">{Math.round(level * 100)}%</span>
          </label>
        </section>

        <IconPicker auth={auth} />
        <PasswordChange auth={auth} />
        {auth.user?.isAdmin && <ResetSomebody />}

        <div className="focus__actions">
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Your badge, chosen from the cards themselves.
 *
 * The game already ships 448 pieces of art and serves them, so a player picks
 * a character they play rather than an avatar somebody has to draw. Only
 * characters are offered — an Effect card's art is a scene, and a scene
 * cropped to a disc is not a face.
 */
function IconPicker({ auth }: { auth: Auth }): JSX.Element {
  const [choices, setChoices] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const current = auth.user?.icon ?? null;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = (await fetch(`${API}/api/catalogue`).then((r) => r.json())) as {
          cards: readonly {
            id: string;
            name: string | null;
            type: string | null;
            unique?: boolean | null;
          }[];
        };
        // The named, Unique characters: the people from the story, rather than
        // four hundred anonymous soldiers to scroll past.
        //
        // Filtered on the rows just fetched rather than through `statsOf`,
        // which reads the shared catalogue store — that is loading in
        // parallel, and on a cold page it had not arrived yet, so every card
        // failed the test and the picker came up empty.
        const named = body.cards
          .filter((card) => card.unique && card.name && card.type === 'character')
          .map((card) => card.id);
        if (!cancelled) setChoices(named);
      } catch {
        if (!cancelled) setError('Could not load the cards.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const choose = async (icon: string | null): Promise<void> => {
    setSaving(true);
    setError(await auth.setIcon(icon));
    setSaving(false);
  };

  return (
    <section className="settings__group">
      <h3 className="settings__heading">Your badge</h3>
      <p className="settings__hint">
        {current ? `Currently ${nameOf(current)}.` : 'Currently the first letter of your name.'}
      </p>
      {error && <p className="settings__error">{error}</p>}

      <div className="settings__icons">
        <button
          type="button"
          className={current === null ? 'settings__icon settings__icon--on' : 'settings__icon'}
          onClick={() => void choose(null)}
          disabled={saving}
          aria-pressed={current === null}
          title="Your initial"
        >
          <span className="settings__initial">{auth.user?.username.charAt(0).toUpperCase()}</span>
        </button>

        {choices.map((id) => (
          <button
            key={id}
            type="button"
            className={current === id ? 'settings__icon settings__icon--on' : 'settings__icon'}
            onClick={() => void choose(id)}
            disabled={saving}
            aria-pressed={current === id}
            title={nameOf(id)}
          >
            <CardImage defId={id} className="settings__iconart" />
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * Resetting somebody else's password. Operators only.
 *
 * This server has no recovery email, so a player locked out is let back in by
 * a person. The panel is only rendered for an operator, and the routes behind
 * it answer 404 to everyone else — the check that matters is the server's.
 */
function ResetSomebody(): JSX.Element {
  const [term, setTerm] = useState('');
  const [found, setFound] = useState<
    readonly { id: string; username: string; lastSeenAt: string | null }[]
  >([]);
  const [picked, setPicked] = useState<{ id: string; username: string } | null>(null);
  const [next, setNext] = useState('');
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null);

  const search = async (): Promise<void> => {
    const response = await fetch(`${API}/api/admin/users?q=${encodeURIComponent(term)}`, {
      headers: authHeaders(),
    });
    if (!response.ok) {
      setNote({ error: true, text: 'Could not search.' });
      return;
    }
    const body = (await response.json()) as { users: typeof found };
    setFound(body.users);
    setNote(body.users.length === 0 ? { error: false, text: 'Nobody by that name.' } : null);
  };

  const reset = async (): Promise<void> => {
    if (!picked) return;
    const response = await fetch(`${API}/api/admin/users/${picked.id}/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ next }),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) {
      setNote({ error: true, text: body.error ?? 'Could not reset it.' });
      return;
    }
    setNext('');
    setNote({ error: false, text: `${picked.username} can sign in with that password now.` });
  };

  return (
    <section className="settings__group">
      <h3 className="settings__heading">Reset a password</h3>
      <p className="settings__hint">
        For a player who is locked out. Tell them the new password yourself — nothing is emailed.
      </p>

      <form
        className="settings__search"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <input
          value={term}
          placeholder="Username"
          onChange={(event) => setTerm(event.target.value)}
        />
        <button type="submit" className="btn" disabled={!term.trim()}>
          Find
        </button>
      </form>

      {found.length > 0 && (
        <div className="settings__found">
          {found.map((user) => (
            <button
              key={user.id}
              type="button"
              className={
                picked?.id === user.id
                  ? 'settings__person settings__person--on'
                  : 'settings__person'
              }
              onClick={() => setPicked({ id: user.id, username: user.username })}
              aria-pressed={picked?.id === user.id}
            >
              <span>{user.username}</span>
              <span className="settings__seen">
                {user.lastSeenAt ? `last seen ${user.lastSeenAt.slice(0, 10)}` : 'never signed in'}
              </span>
            </button>
          ))}
        </div>
      )}

      {picked && (
        <form
          className="settings__form"
          onSubmit={(event) => {
            event.preventDefault();
            void reset();
          }}
        >
          <input
            type="text"
            placeholder={`New password for ${picked.username}`}
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
          <button type="submit" className="btn" disabled={!next}>
            Reset {picked.username}’s password
          </button>
        </form>
      )}

      {note && <p className={note.error ? 'settings__error' : 'settings__ok'}>{note.text}</p>}
    </section>
  );
}

/**
 * Changing a password you know.
 *
 * Not a *reset*: this asks for the current password. A player who has
 * forgotten theirs is let back in by an operator, above.
 */
function PasswordChange({ auth }: { auth: Auth }): JSX.Element {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (next !== again) {
      setNote({ error: true, text: 'The new passwords do not match.' });
      return;
    }
    setBusy(true);
    const problem = await auth.changePassword(current, next);
    setBusy(false);
    if (problem) {
      setNote({ error: true, text: problem });
      return;
    }
    setCurrent('');
    setNext('');
    setAgain('');
    setNote({ error: false, text: 'Password changed.' });
  };

  return (
    <section className="settings__group">
      <h3 className="settings__heading">Password</h3>
      <form
        className="settings__form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          type="password"
          placeholder="Current password"
          autoComplete="current-password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
        />
        <input
          type="password"
          placeholder="New password"
          autoComplete="new-password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
        />
        <input
          type="password"
          placeholder="New password again"
          autoComplete="new-password"
          value={again}
          onChange={(event) => setAgain(event.target.value)}
        />
        <button type="submit" className="btn" disabled={busy || !current || !next}>
          Change password
        </button>
      </form>
      {note && <p className={note.error ? 'settings__error' : 'settings__ok'}>{note.text}</p>}
    </section>
  );
}
