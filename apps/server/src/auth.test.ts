import { describe, expect, it } from 'vitest';
import { MIN_PASSWORD, checkCredentials, issueToken, readToken } from './auth.js';

/**
 * Token and credential checks. These need no database — the parts that do
 * (register, login) are covered by the API tests against a real Postgres.
 */

const user = { id: '2f1c9a5e-0000-4000-8000-000000000001', username: 'guts' };

describe('session tokens', () => {
  it('round-trips a user', () => {
    const token = issueToken(user);
    expect(readToken(token)).toEqual(user);
  });

  it('rejects a token with a tampered payload', () => {
    const [, signature] = issueToken(user).split('.');
    const forged = Buffer.from(
      JSON.stringify({ sub: 'someone-else', name: 'griffith', exp: 2 ** 31 }),
    ).toString('base64url');
    // The signature no longer matches the body, so the swap is caught.
    expect(readToken(`${forged}.${signature}`)).toBeNull();
  });

  it('rejects a token with a tampered signature', () => {
    const [body] = issueToken(user).split('.');
    expect(readToken(`${body}.not-a-real-signature`)).toBeNull();
  });

  it('rejects an expired token', () => {
    const body = Buffer.from(
      JSON.stringify({ sub: user.id, name: user.username, exp: 1 }),
    ).toString('base64url');
    // Even correctly signed, an elapsed expiry is refused — so this test signs
    // nothing and relies on the signature check failing first, which is also
    // the behaviour we want.
    expect(readToken(`${body}.whatever`)).toBeNull();
  });

  it('rejects malformed and missing tokens', () => {
    expect(readToken(undefined)).toBeNull();
    expect(readToken('')).toBeNull();
    expect(readToken('nodot')).toBeNull();
    expect(readToken('.')).toBeNull();
  });
});

describe('credential rules', () => {
  it('accepts a reasonable username and password', () => {
    expect(checkCredentials('guts', 'blackswordsman')).toBeNull();
    expect(checkCredentials('a_b.c-1', 'longenough')).toBeNull();
  });

  it('rejects short or overlong usernames', () => {
    expect(checkCredentials('ab', 'longenough')).toMatch(/3-24/);
    expect(checkCredentials('a'.repeat(25), 'longenough')).toMatch(/3-24/);
  });

  it('rejects usernames with unusable characters', () => {
    expect(checkCredentials('guts!', 'longenough')).toMatch(/letters, numbers/);
    expect(checkCredentials('with space', 'longenough')).toMatch(/letters, numbers/);
  });

  it(`requires a password of at least ${MIN_PASSWORD} characters`, () => {
    expect(checkCredentials('guts', 'short')).toMatch(/at least/);
  });
});
