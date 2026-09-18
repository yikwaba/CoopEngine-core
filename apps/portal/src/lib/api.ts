/**
 * Portal API client. The backend is a separate service; the portal talks to
 * it over HTTP with bearer tokens (never stores secrets beyond the session
 * access token, kept in localStorage for this staff-portal build).
 */

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3999/api/v1';

export interface SessionTokens {
  accessToken: string;
  refreshToken?: string;
}

export interface LoginOutcome {
  user: { id: string; email: string; mfaEnabled: boolean };
  organizations: { id: string; slug: string; name: string; roleCodes: string[] }[];
  requiresOrgSelection?: boolean;
  requiresMfa?: boolean;
  mfaToken?: string;
  tokens?: SessionTokens;
}

export async function apiFetch<T>(
  path: string,
  _token?: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    // The browser attaches the session cookie; there is no token to attach by hand.
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });
  if (res.status === 401) {
    clearSession();
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { message?: string | string[] };
      if (Array.isArray(body.message)) message = body.message.join('; ');
      else if (body.message) message = body.message;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
  // A 200 can carry an empty body (e.g. "nothing to return yet"); parsing that as JSON
  // throws "Unexpected end of JSON input" and takes the whole page down with it.
  const text = await res.text();
  return (text ? (JSON.parse(text) as T) : (null as T));
}

/**
 * Legacy key from builds that kept the token in browser storage. Only ever removed.
 */
export const TOKEN_KEY = 'coopengine_access_token';
export const USER_KEY = 'coopengine_user';
/** Presence means "a session is believed to exist" — the cookie itself is invisible here. */
export const SESSION_MARKER = 'coopengine_session';

export function storeSession(_tokens: SessionTokens, email: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(SESSION_MARKER, 'cookie');
  localStorage.setItem(USER_KEY, JSON.stringify({ email }));
  localStorage.removeItem(TOKEN_KEY);
}

export function clearSession(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(SESSION_MARKER);
}

/**
 * End the server-side session before removing the browser's local marker.
 * Clearing localStorage alone does not remove an httpOnly cookie and therefore is not logout.
 */
export async function logoutSession(): Promise<void> {
  try {
    await apiFetch<void>('/auth/logout', undefined, { method: 'POST', body: '{}' });
  } finally {
    clearSession();
  }
}

export function readToken(): string | null {
  if (typeof window === 'undefined') return null;
  localStorage.removeItem(TOKEN_KEY);
  return localStorage.getItem(SESSION_MARKER);
}

/**
 * Fetch a PDF with the session token and hand it to the browser as a download.
 * A plain <a href> cannot carry the Authorization header, so documents are
 * fetched as a blob and saved through a temporary object URL.
 */
export async function downloadPdf(path: string, filename: string): Promise<void> {
  const token = readToken();
  if (!token) {
    throw new Error('Not signed in');
  }
  // The session cookie travels with this request; nothing is attached by hand.
  const res = await fetch(`${API_BASE}${path}`, { credentials: 'include' });
  if (!res.ok) {
    throw new Error(`Could not generate the document (${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
