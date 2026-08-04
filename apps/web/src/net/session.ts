/**
 * The session token, in one place.
 *
 * Both the REST client and the socket need it — the API sends it as a bearer
 * header, the socket presents it at handshake — so it does not belong to
 * either of them. It lives in `localStorage` so a reload stays signed in.
 *
 * A bearer header rather than a cookie keeps the API free of CSRF concerns.
 */

const TOKEN_KEY = 'berserk:token';

export const authToken = (): string | null => localStorage.getItem(TOKEN_KEY);

export function setAuthToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAuthToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** Adds the bearer header when signed in. Use for every API call. */
export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = authToken();
  return token ? { ...extra, authorization: `Bearer ${token}` } : extra;
}
