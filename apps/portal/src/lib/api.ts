/** Portal API client. Authentication uses the backend's HttpOnly session cookie. */

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
  requiresMfaEnrollment?: boolean;
  enrollment?: { secret: string; otpauthUrl: string };
  recoveryCodes?: string[];
  tokens?: SessionTokens;
}

/** Raw authenticated response for paginated lists and binary downloads. */
export async function apiResponse(path: string, init?: RequestInit): Promise<Response> {
  let res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    cache: 'no-store',
  });
  // Only this explicit pre-operation refusal may retry a mutation. Never retry
  // a timeout, network error, ordinary 403, 5xx or a failed verification.
  if (res.status === 403 && typeof window !== 'undefined' &&
      !new Headers(init?.headers).has('X-CoopEngine-Step-Up')) {
    const refusal = await res.clone().json().catch(() => null) as {code?: string; message?: string} | null;
    if (refusal?.code === 'STEP_UP_REQUIRED') {
      const code = await requestStepUp(refusal.message ?? 'Verify this action');
      if (code) {
        const headers = new Headers(init?.headers); headers.set('X-CoopEngine-Step-Up', code);
        res = await fetch(`${API_BASE}${path}`, {...init, headers, credentials:'include', cache:'no-store'});
      }
    }
  }
  if (res.status === 401) {
    clearSession();
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
  }
  return res;
}

export async function apiFetch<T>(
  path: string,
  _token?: string,
  init?: RequestInit,
): Promise<T> {
  const intent=prepareFinancialWrite(path,init);
  if (intent) init={...init,body:intent.body};
  const res = await apiResponse(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
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

/** Fetch a private PDF using the session cookie and save it as a browser download. */
export async function downloadPdf(path: string, filename: string): Promise<void> {
  const token = readToken();
  if (!token) {
    throw new Error('Not signed in');
  }
  // The session cookie travels with this request; nothing is attached by hand.
  const res = await apiResponse(path);
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

export const STEP_UP_EVENT = 'coopengine-step-up';
export interface StepUpRequest { message: string; resolve: (code: string | null) => void; }
/** OTP stays in this request's memory; never storage, a URL or an auth token. */
function requestStepUp(message: string): Promise<string | null> {
  return new Promise(resolve => {
    window.dispatchEvent(new CustomEvent<StepUpRequest>(STEP_UP_EVENT, {detail:{message, resolve}}));
  });
}

interface FinancialBrowserIntent { storageKey:string; key:string; body:string }
/** Keep one intent through uncertain responses and refresh; successful acknowledgement ends it. */
export function prepareFinancialWrite(path:string,init?:RequestInit):FinancialBrowserIntent|null {
 const keyed=/^\/savings\/accounts\/[^/]+\/(deposits|withdrawals)$/.test(path) ||
   /^\/loans\/[^/]+\/repayments$/.test(path) ||
   /^\/shares\/member\/[^/]+\/(purchases|redemptions)$/.test(path) || path==='/member/withdrawals/request';
 const stepped=/^\/savings\/withdrawals\/[^/]+\/(approve|reject)$/.test(path) || /^\/approvals\/requests\/[^/]+\/decisions$/.test(path);
 const natural=stepped || /^\/loans\/[^/]+\/(approve|reject|disburse)$/.test(path) ||
   /^\/payroll\/batches\/[^/]+\/(approve|reject|reverse)$/.test(path) ||
   /^\/approvals\/payroll\/[^/]+\/(approve|reject)$/.test(path) ||
   /^\/ledger\/journals\/[^/]+\/(approve-post|reverse)$/.test(path) || /^\/approvals\/journals\/[^/]+\/approve$/.test(path);
 if (typeof window==='undefined' || init?.method?.toUpperCase()!=='POST' || !(keyed || natural)) return null;
 if (typeof init.body!=='string') throw new Error('Payment details must be JSON.');
 const details=JSON.parse(init.body) as Record<string,unknown>;
 if (keyed && details.idempotencyKey) return null;
 const identity=localStorage.getItem(USER_KEY)??'session';
 const storageKey='coopengine-payment:'+identity+':'+path;
 let payload=JSON.stringify(details);
 const old=sessionStorage.getItem(storageKey);
 const pending=old?JSON.parse(old) as {key:string;payload:string}:null;
 if (pending && stepped) {
  const original=JSON.parse(pending.payload) as Record<string,unknown>;
  if ('expectedStepNo' in original) details.expectedStepNo=original.expectedStepNo;
  else delete details.expectedStepNo;
  payload=JSON.stringify(details);
 }
 if (pending && pending.payload!==payload) throw new Error('A previous payment has an uncertain result. Retry its original details or review the account before starting another payment.');
 const key=pending?.key??crypto.randomUUID();
 sessionStorage.setItem(storageKey,JSON.stringify({key,payload}));
 return {storageKey,key,body:keyed?JSON.stringify({...details,idempotencyKey:key}):payload};
}
export function acknowledgeFinancialWrite(intent:FinancialBrowserIntent|null):void {
 if (!intent) return;
 const current=sessionStorage.getItem(intent.storageKey);
 if (current && (JSON.parse(current) as {key:string}).key===intent.key) sessionStorage.removeItem(intent.storageKey);
}
