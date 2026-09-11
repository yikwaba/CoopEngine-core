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
  token?: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });
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
  return (await res.json()) as T;
}

export const TOKEN_KEY = 'coopengine_access_token';
export const USER_KEY = 'coopengine_user';

export function storeSession(tokens: SessionTokens, email: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(TOKEN_KEY, tokens.accessToken);
  localStorage.setItem(USER_KEY, JSON.stringify({ email }));
}

export function clearSession(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function readToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
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
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
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
