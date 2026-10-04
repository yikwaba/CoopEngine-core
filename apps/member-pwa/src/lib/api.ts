/** Member PWA API client (self-service, OTP auth). */

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3999/api/v1';

/**
 * Member app API client.
 *
 * The session is an httpOnly cookie set by the API, so the token is never visible to JavaScript —
 * a cross-site scripting bug cannot lift a member's session out of browser storage. Only *who* is
 * signed in is kept locally, for the header. A token written by an earlier build is deleted on
 * sight, so an upgrade does not leave one lying around.
 */
export async function apiFetch<T>(
  path: string,
  _token?: string,
  init?: RequestInit,
): Promise<T> {
  const intent=prepareFinancialWrite(path,init);
  if (intent) init={...init,body:intent.body};
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    // The member's session is an httpOnly cookie: the browser attaches it, scripts cannot read it.
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });
  if (res.status === 401) {
    clearMemberSession();
  }
  if ([400,403,404,422].includes(res.status)) acknowledgeFinancialWrite(intent);
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
  const result=(text ? JSON.parse(text) : null) as T;
  acknowledgeFinancialWrite(intent);
  return result;
}

export const MEMBER_TOKEN_KEY = 'coopengine_member_token';
export const MEMBER_INFO_KEY = 'coopengine_member_info';

export function storeMemberSession(_accessToken: string, info: unknown): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(MEMBER_TOKEN_KEY);
  localStorage.setItem(MEMBER_SESSION_MARKER, 'cookie');
  localStorage.setItem(MEMBER_INFO_KEY, JSON.stringify(info));
}

export function clearMemberSession(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(MEMBER_TOKEN_KEY);
  localStorage.removeItem(MEMBER_INFO_KEY);
  localStorage.removeItem(MEMBER_SESSION_MARKER);
}

/** Clear the API's httpOnly cookie as well as the local signed-in marker. */
export async function logoutMemberSession(): Promise<void> {
  try {
    await apiFetch<void>('/auth/member/logout', undefined, { method: 'POST', body: '{}' });
  } finally {
    clearMemberSession();
  }
}

export const MEMBER_SESSION_MARKER = 'coopengine_member_session';

/** Non-null when a session is believed to exist; the cookie itself is invisible here. */
export function readMemberToken(): string | null {
  if (typeof window === 'undefined') return null;
  localStorage.removeItem(MEMBER_TOKEN_KEY);
  return localStorage.getItem(MEMBER_SESSION_MARKER);
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
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
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

interface FinancialBrowserIntent { storageKey:string; key:string; body:string }
/** Keep one intent through uncertain responses and refresh; successful acknowledgement ends it. */
export function prepareFinancialWrite(path:string,init?:RequestInit):FinancialBrowserIntent|null {
 if (typeof window==='undefined' || init?.method?.toUpperCase()!=='POST' ||
     !(/^\/savings\/accounts\/[^/]+\/(deposits|withdrawals)$/.test(path) ||
       /^\/loans\/[^/]+\/repayments$/.test(path) ||
       /^\/shares\/member\/[^/]+\/(purchases|redemptions)$/.test(path) || path==='/member/withdrawals/request')) return null;
 if (typeof init.body!=='string') throw new Error('Payment details must be JSON.');
 const details=JSON.parse(init.body) as Record<string,unknown>;
 if (details.idempotencyKey) return null;
 const identity=localStorage.getItem(MEMBER_INFO_KEY)??'session';
 const storageKey='coopengine-payment:'+identity+':'+path;
 const payload=JSON.stringify(details);
 const old=sessionStorage.getItem(storageKey);
 const pending=old?JSON.parse(old) as {key:string;payload:string}:null;
 if (pending && pending.payload!==payload) throw new Error('A previous payment has an uncertain result. Retry its original details or review the account before starting another payment.');
 const key=pending?.key??crypto.randomUUID();
 sessionStorage.setItem(storageKey,JSON.stringify({key,payload}));
 return {storageKey,key,body:JSON.stringify({...details,idempotencyKey:key})};
}
export function acknowledgeFinancialWrite(intent:FinancialBrowserIntent|null):void {
 if (!intent) return;
 const current=sessionStorage.getItem(intent.storageKey);
 if (current && (JSON.parse(current) as {key:string}).key===intent.key) sessionStorage.removeItem(intent.storageKey);
}
