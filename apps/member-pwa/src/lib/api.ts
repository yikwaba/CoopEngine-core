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
  const intent=await prepareFinancialWrite(path,init).catch(error=>{notifyFinancialWrites();throw error;});
  if (intent) init={...init,body:intent.body,headers:{...init?.headers,'X-CoopEngine-Financial-Scope':intent.scope}};
  try {
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
  if ([400,422].includes(res.status) && !intent?.wasPending) acknowledgeFinancialWrite(intent);
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
  if (intent && !text) throw new Error('The financial response was empty. Recover the original request to confirm its result.');
  const result=(text ? JSON.parse(text) : null) as T;
  if (intent && (result===null || typeof result!=='object')) throw new Error('The financial response was invalid. The original request is retained.');
  acknowledgeFinancialWrite(intent);
  return result;
  } catch (error) {
    notifyFinancialWrites();
    throw error;
  }
}

export const MEMBER_TOKEN_KEY = 'coopengine_member_token';
export const MEMBER_INFO_KEY = 'coopengine_member_info';

export function storeMemberSession(_accessToken: string, info: unknown): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(MEMBER_TOKEN_KEY);
  localStorage.setItem(MEMBER_SESSION_MARKER, 'cookie');
  localStorage.setItem(MEMBER_INFO_KEY, JSON.stringify(info));
  notifyFinancialWrites();
}

export function clearMemberSession(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(MEMBER_TOKEN_KEY);
  localStorage.removeItem(MEMBER_INFO_KEY);
  localStorage.removeItem(MEMBER_SESSION_MARKER);
  notifyFinancialWrites();
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

export interface FinancialBrowserIntent { storageKey:string; key:string; body:string; scope:string; wasPending:boolean }
/** Keep one intent through uncertain responses and refresh; successful acknowledgement ends it. */
export async function prepareFinancialWrite(path:string,init?:RequestInit):Promise<FinancialBrowserIntent|null> {
 if (typeof window==='undefined' || init?.method?.toUpperCase()!=='POST' ||
     !(/^\/savings\/accounts\/[^/]+\/(deposits|withdrawals)$/.test(path) ||
       /^\/loans\/[^/]+\/repayments$/.test(path) ||
       /^\/shares\/member\/[^/]+\/(purchases|redemptions)$/.test(path) || path==='/member/withdrawals/request')) return null;
 if (typeof init.body!=='string') throw new Error('Payment details must be JSON.');
 const details=JSON.parse(init.body) as Record<string,unknown>;

 const identity=localStorage.getItem(MEMBER_INFO_KEY);
 if (!identity) throw new Error('Sign in before sending a financial request.');
 const storageKey='coopengine-payment:'+identity+':'+path;
 const payload=JSON.stringify(details);
 const old=sessionStorage.getItem(storageKey);
 const pending=old?JSON.parse(old) as {key:string;payload:string;scope?:string}:null;
 if (pending && pending.payload!==payload) throw new Error('A previous payment has an uncertain result. Retry its original details or review the account before starting another payment.');
 if (pending && !pending.scope) throw new Error('This older pending request needs account review before another payment. Its original record has been retained.');
 const reservedKey=pending?.key??(typeof details.idempotencyKey==='string'?details.idempotencyKey:crypto.randomUUID());
 if (!pending) sessionStorage.setItem(storageKey,JSON.stringify({key:reservedKey,payload,scope:'UNSENT'}));
 const response=await fetch(`${API_BASE}/member/me`,{credentials:'include',cache:'no-store'});
 if (!response.ok) throw new Error('Sign in to the original account before recovering a financial request.');
 const context=await response.json() as {financialScope?:string};
 if (!context.financialScope) throw new Error('Financial account verification failed. No payment was sent.');
 if (pending && pending.scope!=='UNSENT' && pending.scope!==context.financialScope) throw new Error('This pending request belongs to another account or cooperative. Sign in to its original account.');
 // Recheck after the asynchronous account lookup: two submissions must claim one intent.
 const latest=sessionStorage.getItem(storageKey);
 const concurrent=latest?JSON.parse(latest) as {key:string;payload:string;scope:string}:null;
 if (concurrent && (concurrent.key!==reservedKey || concurrent.payload!==payload || (concurrent.scope!=='UNSENT' && concurrent.scope!==context.financialScope))) throw new Error('A previous payment has an uncertain result. Recover it first.');
 const key=reservedKey;
 const scope=context.financialScope;
 sessionStorage.setItem(storageKey,JSON.stringify({key,payload,scope}));
 notifyFinancialWrites();
 return {storageKey,key,scope,wasPending:!!pending && pending.scope!=='UNSENT',body:JSON.stringify({...details,idempotencyKey:key})};
}
export function acknowledgeFinancialWrite(intent:FinancialBrowserIntent|null):void {
 if (!intent) return;
 const current=sessionStorage.getItem(intent.storageKey);
 if (current && (JSON.parse(current) as {key:string}).key===intent.key) sessionStorage.removeItem(intent.storageKey);
 notifyFinancialWrites();
}

export const FINANCIAL_WRITES_EVENT = 'coopengine-financial-writes';
function notifyFinancialWrites(): void {
 if (typeof window!=='undefined' && typeof window.dispatchEvent==='function') window.dispatchEvent(new Event(FINANCIAL_WRITES_EVENT));
}
/** Only records for the currently signed-in browser identity are exposed. Never offer discard. */
export function pendingFinancialWrites(): {storageKey:string;path:string;key:string;scope?:string;payload:string}[] {
 if (typeof window==='undefined' || !localStorage.getItem(MEMBER_SESSION_MARKER)) return [];
 const identity=localStorage.getItem(MEMBER_INFO_KEY);
 if (!identity) return [];
 const prefix='coopengine-payment:'+identity+':';
 const result=[];
 for(let i=0;i<sessionStorage.length;i++) {
  const storageKey=sessionStorage.key(i);
  if (!storageKey?.startsWith(prefix)) continue;
  try {
   const record=JSON.parse(sessionStorage.getItem(storageKey)??'null');
   if (record && typeof record.payload==='string' && typeof record.key==='string') result.push({storageKey,path:storageKey.slice(prefix.length),...record});
  } catch { /* A malformed record is retained for review, never replaced by a new key. */ }
 }
 return result;
}
export async function recoverFinancialWrite(storageKey:string):Promise<unknown> {
 const pending=pendingFinancialWrites().find(record=>record.storageKey===storageKey);
 if (!pending) throw new Error('This pending request is unavailable for the signed-in account.');
 if (!pending.scope) throw new Error('This older request needs account review. Its original record has been retained.');
 // Use the ordinary authorized route, current permissions, and step-up verification.
 return apiFetch(pending.path,undefined,{method:'POST',body:pending.payload});
}
