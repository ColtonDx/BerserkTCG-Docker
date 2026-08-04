import { useState, type JSX } from 'react';
import wallpaper from '../../../../art-assets/wallpaper.jpg';
import type { Auth } from '../state/useAuth.js';
import { Embers } from './Embers.js';

/**
 * Sign in or create an account. DesignNotes 1-2.
 *
 * Shares the lobby's treatment — the artwork supplies the masthead, controls
 * sit in the lower third — so signing in feels like part of the game rather
 * than a gate in front of it.
 *
 * The "create account" tab only appears when the server allows registration,
 * which is the deployment switch from DesignNotes 2.
 *
 * There is no way past this screen. An account is what the socket connects
 * as, so playing without one is not a thing the server can do.
 */

interface Props {
  readonly auth: Auth;
}

export function SignIn({ auth }: Props): JSX.Element {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const registering = mode === 'up';
  const canSubmit = username.trim().length > 0 && password.length > 0 && !auth.busy;

  return (
    <div className="lobby" style={{ backgroundImage: `url(${wallpaper})` }}>
      <div className="lobby__scrim" />
      <Embers />

      <div className="lobby__content">
        <h1 className="visually-hidden">Berserk Trading Card Game</h1>

        <form
          className="lobby__panel"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSubmit) return;
            void (registering
              ? auth.signUp(username.trim(), password)
              : auth.signIn(username.trim(), password));
          }}
        >
          {auth.registrationEnabled && (
            <div className="tabs">
              <button
                type="button"
                className={mode === 'in' ? 'tabs__tab tabs__tab--on' : 'tabs__tab'}
                onClick={() => setMode('in')}
              >
                Sign in
              </button>
              <button
                type="button"
                className={registering ? 'tabs__tab tabs__tab--on' : 'tabs__tab'}
                onClick={() => setMode('up')}
              >
                Create account
              </button>
            </div>
          )}

          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
            aria-label="Username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            aria-label="Password"
            autoComplete={registering ? 'new-password' : 'current-password'}
          />

          <button type="submit" className="btn btn--primary" disabled={!canSubmit}>
            {auth.busy ? 'Please wait…' : registering ? 'Create account' : 'Sign in'}
          </button>
        </form>

        {auth.error && <p className="lobby__error">{auth.error}</p>}

        {!auth.accountsAvailable && (
          <p className="lobby__error">
            This server has no database, so no one can sign in — and playing needs an account. Set{' '}
            <code>DATABASE_URL</code> and restart it.
          </p>
        )}

        {!auth.registrationEnabled && auth.accountsAvailable && (
          <p className="lobby__status">Registration is closed on this server</p>
        )}
      </div>
    </div>
  );
}
