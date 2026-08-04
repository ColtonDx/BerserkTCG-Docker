import { useCallback, useEffect, useState } from 'react';
import { authHeaders, authToken, clearAuthToken, setAuthToken } from '../net/session.js';

/**
 * Sign-in state.
 *
 * An account is required to play: the socket will not connect without one, so
 * this is the gate in front of everything else rather than a convenience.
 * The token itself lives in `net/session.ts`, which both this and the socket
 * read from.
 */

const API = import.meta.env['VITE_SERVER_URL'] ?? '';

export interface Account {
  readonly id: string;
  readonly username: string;
  /** Card number whose art is this player's badge, if they picked one. */
  readonly icon?: string | null;
  /** Operators can reset another player's password. */
  readonly isAdmin?: boolean;
}

export interface Auth {
  readonly user: Account | null;
  readonly checking: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  /** Whether this server accepts new accounts. DesignNotes 2. */
  readonly registrationEnabled: boolean;
  /** False when the server has no database, so accounts are unavailable. */
  readonly accountsAvailable: boolean;
  signIn: (username: string, password: string) => Promise<boolean>;
  signUp: (username: string, password: string) => Promise<boolean>;
  signOut: () => void;
  /** Pick the card whose art is your badge, or null to go back to an initial. */
  setIcon: (icon: string | null) => Promise<string | null>;
  /** Change your password, given the current one. Returns an error, or null. */
  changePassword: (current: string, next: string) => Promise<string | null>;
}

export { authHeaders, authToken } from '../net/session.js';

export function useAuth(): Auth {
  const [user, setUser] = useState<Account | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [accountsAvailable, setAccountsAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const config = await fetch(`${API}/api/auth/config`).then((r) => r.json());
        if (!cancelled) {
          setRegistrationEnabled(Boolean(config.registrationEnabled));
          setAccountsAvailable(Boolean(config.accountsAvailable));
        }

        // A stored token may have expired or been signed with an older secret.
        if (authToken()) {
          const response = await fetch(`${API}/api/auth/me`, { headers: authHeaders() });
          if (response.ok) {
            const body = await response.json();
            if (!cancelled) setUser(body.user as Account);
          } else {
            clearAuthToken();
          }
        }
      } catch {
        // Offline or no server: leave the player signed out rather than stuck.
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = useCallback(async (path: string, username: string, password: string) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${API}/api/auth/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(typeof body.error === 'string' ? body.error : `Failed (${response.status})`);
        return false;
      }
      setAuthToken(body.token as string);
      setUser(body.user as Account);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    user,
    checking,
    busy,
    error,
    registrationEnabled,
    accountsAvailable,
    signIn: (username, password) => submit('login', username, password),
    signUp: (username, password) => submit('register', username, password),
    signOut: () => {
      clearAuthToken();
      setUser(null);
    },

    setIcon: async (icon) => {
      const response = await fetch(`${API}/api/auth/me`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ icon }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        return (body as { error?: string }).error ?? 'Could not save that.';
      }
      // Kept locally as well as on the server, so the badge changes at once
      // rather than at the next sign-in.
      setUser((current) => (current ? { ...current, icon } : current));
      return null;
    },

    changePassword: async (current, next) => {
      const response = await fetch(`${API}/api/auth/password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ current, next }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        token?: string;
      };
      if (!response.ok) return body.error ?? 'Could not change it.';
      // The server hands back a fresh token; taking it keeps this tab signed
      // in rather than dropping it on the next request.
      if (body.token) setAuthToken(body.token);
      return null;
    },
  };
}
