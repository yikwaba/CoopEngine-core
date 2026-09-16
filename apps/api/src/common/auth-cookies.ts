/**
 * Session cookies.
 *
 * Access and refresh tokens live in httpOnly cookies so a single cross-site scripting bug cannot
 * read them out of JavaScript and walk away with a session. The API still accepts a bearer token,
 * because scripts, tests, the reconciliation tooling and provider callbacks are not browsers —
 * the cookie is an addition, not a replacement.
 *
 * Parsing is done by hand rather than with cookie-parser: two fixed names, and the middleware
 * chain stays as it is.
 *
 * CSRF: the cookies are SameSite=Lax and CORS allows credentials only from the known portal
 * origins, so a cross-site page cannot make a state-changing request with the session attached.
 */
import type { Request, Response } from 'express';

export const ACCESS_COOKIE = 'ce_at';
export const REFRESH_COOKIE = 'ce_rt';

function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

export function readAccessCookie(req: Request): string | null {
  const value = parseCookieHeader(req.headers?.cookie)[ACCESS_COOKIE];
  return value && value.length > 0 ? value : null;
}

export function readRefreshCookie(req: Request): string | null {
  const value = parseCookieHeader(req.headers?.cookie)[REFRESH_COOKIE];
  return value && value.length > 0 ? value : null;
}

/** Only over HTTPS: a Secure cookie is dropped by browsers on plain http, which is correct. */
function secure(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function setSessionCookies(
  res: Response,
  tokens: { accessToken: string; refreshToken?: string },
  accessTtlSeconds: number,
): void {
  res.cookie(ACCESS_COOKIE, tokens.accessToken, {
    httpOnly: true,
    secure: secure(),
    sameSite: 'lax',
    path: '/',
    maxAge: Math.max(accessTtlSeconds, 60) * 1000,
  });
  if (tokens.refreshToken) {
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      secure: secure(),
      sameSite: 'lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
  }
}

export function clearSessionCookies(res: Response): void {
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE]) {
    res.clearCookie(name, { httpOnly: true, secure: secure(), sameSite: 'lax', path: '/' });
  }
}
