/** Member PWA API client (self-service, OTP auth). */

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3999/api/v1';

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
  // A 200 can carry an empty body (e.g. "nothing to return yet"); parsing that as JSON
  // throws "Unexpected end of JSON input" and takes the whole page down with it.
  const text = await res.text();
  return (text ? (JSON.parse(text) as T) : (null as T));
}

export const MEMBER_TOKEN_KEY = 'coopengine_member_token';
export const MEMBER_INFO_KEY = 'coopengine_member_info';

export function storeMemberSession(accessToken: string, info: unknown): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(MEMBER_TOKEN_KEY, accessToken);
  localStorage.setItem(MEMBER_INFO_KEY, JSON.stringify(info));
}

export function clearMemberSession(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(MEMBER_TOKEN_KEY);
  localStorage.removeItem(MEMBER_INFO_KEY);
}

export function readMemberToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(MEMBER_TOKEN_KEY);
}

export function readMemberInfo(): {
  memberNo?: number;
  firstName?: string;
  lastName?: string;
} | null {
  if (typeof window === 'undefined') return null;
  try {
    return JSON.parse(localStorage.getItem(MEMBER_INFO_KEY) ?? 'null') as {
      memberNo?: number;
      firstName?: string;
      lastName?: string;
    } | null;
  } catch {
    return null;
  }
}

/** Fetch a PDF with the member's token and hand it to the browser as a download. */
export async function downloadMemberPdf(path: string, filename: string): Promise<void> {
  const token = readMemberToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? 'There is nothing to print for you yet.'
        : `Could not prepare the document (${res.status})`,
    );
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
