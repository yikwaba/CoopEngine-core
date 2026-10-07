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

async function sendApiFetch<T>(
  path: string,
  _token?: string,
  init?: RequestInit,
): Promise<T> {
  const intent=await prepareFinancialWrite(path,init).catch(error=>{notifyFinancialWrites();throw error;});
  if (intent) init={...init,body:intent.body,headers:{...init?.headers,'X-CoopEngine-Financial-Scope':intent.scope}};
  try {
  const res = await apiResponse(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
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
  notifyFinancialWrites();
}

export function clearSession(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(SESSION_MARKER);
  notifyFinancialWrites();
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

/** Exclusion spans verification, send and acknowledgement; a second tab never queues a new payment. */
export async function apiFetch<T>(path:string,token?:string,init?:RequestInit):Promise<T> {
 if (typeof window==='undefined' || init?.method?.toUpperCase()!=='POST' || !isFinancialPath(path)) return sendApiFetch<T>(path,token,init);
 if (!window.navigator?.locks) throw new Error('This browser cannot safely coordinate financial requests. Use a supported browser over HTTPS or localhost. No payment was sent.');
 return window.navigator.locks.request('coopengine-financial-write', {ifAvailable:true}, async lock=>{
  if (!lock) throw new Error('A financial request is already being checked in another tab or window. Wait for its result, then recover the original request if needed. No second payment was sent.');
  migrateLegacyFinancialRecords();
  return sendApiFetch<T>(path,token,init);
 });
}
function isFinancialPath(path:string):boolean {
 return path==='/loans' || path==='/ledger/journals' || path==='/payroll/import/preview' || path==='/payroll/import/commit' || /^\/savings\/accounts\/[^/]+\/(deposits|withdrawals)$/.test(path) ||
  /^\/loans\/[^/]+\/repayments$/.test(path) || /^\/shares\/member\/[^/]+\/(purchases|redemptions)$/.test(path) || path==='/member/withdrawals/request' || path==='/savings/interest/post' || path==='/dividends/post' ||
  /^\/savings\/withdrawals\/[^/]+\/(approve|reject)$/.test(path) || /^\/approvals\/requests\/[^/]+\/decisions$/.test(path) ||
  /^\/loans\/[^/]+\/(approve|reject|disburse)$/.test(path) || /^\/payroll\/batches\/[^/]+\/(approve|reject|reverse)$/.test(path) ||
  /^\/approvals\/payroll\/[^/]+\/(approve|reject)$/.test(path) || /^\/ledger\/journals\/[^/]+\/(submit|approve-post|reverse)$/.test(path) || /^\/approvals\/journals\/[^/]+\/approve$/.test(path);
}
/** Display fields never define the durable account namespace. Server scope still authorizes replay. */
function financialBrowserIdentity(raw:string|null):string|null {
 try {
  const identity=JSON.parse(raw??'null') as Record<string,unknown>|null;
  const value=identity?.email;
  return typeof value==='string' && value.trim()?JSON.stringify({email:value.trim().toLowerCase()}):null;
 }catch{return null;}
}
/** Import tab records and old display-field namespaces without overwriting conflicting intents. */
function migrateLegacyFinancialRecords():void {
 const identity=financialBrowserIdentity(localStorage.getItem(USER_KEY));if(!identity) return;
 const prefix='coopengine-payment:',sources:{storage:Storage;key:string}[]=[];
 for(const storage of [localStorage,sessionStorage]) {
  for(let i=0;i<storage.length;i++) {const key=storage.key(i);if(key?.startsWith(prefix)) sources.push({storage,key});}
 }
 for(const {storage,key:sourceKey} of sources) {
  // The final JSON object terminator separates old identity metadata from the API route.
  const separator=sourceKey.lastIndexOf('}:/');
  if(separator<0 || financialBrowserIdentity(sourceKey.slice(prefix.length,separator+1))!==identity) continue;
  const storageKey=prefix+identity+sourceKey.slice(separator+1);
  if(storage===localStorage && sourceKey===storageKey) continue;
  const raw=storage.getItem(sourceKey);if(!raw) continue;
  const old=JSON.parse(raw) as {key:string;payload:string;scope?:string};
  if(!old || typeof old.key!=='string' || typeof old.payload!=='string') throw new Error('An older financial request needs account review. Its original record is retained.');
  const ack='coopengine-payment-ack:'+storageKey+':'+old.key;
  // Respect both the canonical marker and the marker written by the previous display-field namespace.
  if(localStorage.getItem(ack)==='acknowledged' || localStorage.getItem('coopengine-payment-ack:'+sourceKey+':'+old.key)==='acknowledged') {
   localStorage.setItem(ack,'acknowledged');storage.removeItem(sourceKey);continue;
  }
  const current=localStorage.getItem(storageKey);
  if(current) {
   const record=JSON.parse(current) as {key:string;payload:string;scope?:string};
   if(record.key!==old.key || record.payload!==old.payload || record.scope!==old.scope) throw new Error('Conflicting financial records from older tabs need account review. Both original records are retained.');
  }
  localStorage.setItem(storageKey,JSON.stringify({...old,legacy:true}));
  storage.removeItem(sourceKey);
 }
}
/** Import legacy records before rendering recovery under the same cross-tab lock. */
export async function syncFinancialWrites():Promise<void> {
 if(typeof window==='undefined' || !window.navigator?.locks) return;
 await window.navigator.locks.request('coopengine-financial-write',()=>{migrateLegacyFinancialRecords();});
}

export interface FinancialBrowserIntent { storageKey:string; key:string; body:string; scope:string; wasPending:boolean }
/** Keep one intent across tabs, restarts and uncertain responses; successful acknowledgement ends it. */
export async function prepareFinancialWrite(path:string,init?:RequestInit):Promise<FinancialBrowserIntent|null> {
 const keyed=path==='/loans' || path==='/ledger/journals' || path==='/payroll/import/preview' || /^\/savings\/accounts\/[^/]+\/(deposits|withdrawals)$/.test(path) ||
   /^\/loans\/[^/]+\/repayments$/.test(path) ||
   /^\/shares\/member\/[^/]+\/(purchases|redemptions)$/.test(path) || path==='/member/withdrawals/request';
 const stepped=/^\/savings\/withdrawals\/[^/]+\/(approve|reject)$/.test(path) || /^\/approvals\/requests\/[^/]+\/decisions$/.test(path);
 const natural=path==='/payroll/import/commit' || path==='/savings/interest/post' || path==='/dividends/post' || stepped || /^\/loans\/[^/]+\/(approve|reject|disburse)$/.test(path) ||
   /^\/payroll\/batches\/[^/]+\/(approve|reject|reverse)$/.test(path) ||
   /^\/approvals\/payroll\/[^/]+\/(approve|reject)$/.test(path) ||
   /^\/ledger\/journals\/[^/]+\/(submit|approve-post|reverse)$/.test(path) || /^\/approvals\/journals\/[^/]+\/approve$/.test(path);
 if (typeof window==='undefined' || init?.method?.toUpperCase()!=='POST' || !(keyed || natural)) return null;
 if (typeof init.body!=='string') throw new Error('Payment details must be JSON.');
 const details=JSON.parse(init.body) as Record<string,unknown>;

 const identity=financialBrowserIdentity(localStorage.getItem(USER_KEY));
 if (!identity) throw new Error('Sign in before sending a financial request.');
 const storageKey='coopengine-payment:'+identity+':'+path;
 let payload=JSON.stringify(details);
 const old=localStorage.getItem(storageKey);
 const pending=old?JSON.parse(old) as {key:string;payload:string;scope?:string}:null;
 if(old && (!pending || typeof pending.key!=='string' || typeof pending.payload!=='string')) throw new Error('A malformed financial record needs account review. Its original record is retained.');
 if (pending && stepped) {
  const original=JSON.parse(pending.payload) as Record<string,unknown>;
  if ('expectedStepNo' in original) details.expectedStepNo=original.expectedStepNo;
  else delete details.expectedStepNo;
  payload=JSON.stringify(details);
 }
 if (pending && pending.payload!==payload) throw new Error('A previous payment has an uncertain result. Retry its original details or review the account before starting another payment.');
 if (pending && !pending.scope) throw new Error('This older pending request needs account review before another payment. Its original record has been retained.');
 const reservedKey=pending?.key??(typeof details.idempotencyKey==='string'?details.idempotencyKey:crypto.randomUUID());
 if (!pending) localStorage.setItem(storageKey,JSON.stringify({key:reservedKey,payload,scope:'UNSENT'}));
 const response=await fetch(`${API_BASE}/auth/me`,{credentials:'include',cache:'no-store'});
 if (!response.ok) throw new Error('Sign in to the original account before recovering a financial request.');
 const context=await response.json() as {financialScope?:string};
 if (!context.financialScope) throw new Error('Financial account verification failed. No payment was sent.');
 if (pending && pending.scope!=='UNSENT' && pending.scope!==context.financialScope) throw new Error('This pending request belongs to another account or cooperative. Sign in to its original account.');
 // Recheck after the asynchronous account lookup: two submissions must claim one intent.
 const latest=localStorage.getItem(storageKey);
 const concurrent=latest?JSON.parse(latest) as {key:string;payload:string;scope:string}:null;
 if (concurrent && (concurrent.key!==reservedKey || concurrent.payload!==payload || (concurrent.scope!=='UNSENT' && concurrent.scope!==context.financialScope))) throw new Error('A previous payment has an uncertain result. Recover it first.');
 const key=reservedKey;
 const scope=context.financialScope;
 localStorage.setItem(storageKey,JSON.stringify({key,payload,scope,...(pending && 'legacy' in pending && pending.legacy?{legacy:true}:{})}));
 notifyFinancialWrites();
 return {storageKey,key,scope,wasPending:!!pending && pending.scope!=='UNSENT',body:keyed?JSON.stringify({...details,idempotencyKey:key}):payload};
}
export function acknowledgeFinancialWrite(intent:FinancialBrowserIntent|null):void {
 if (!intent) return;
 const current=localStorage.getItem(intent.storageKey);
 if (current) {
  const record=JSON.parse(current) as {key:string;legacy?:boolean};
  if(record.key===intent.key) {
   // A pre-update tab may still retain this migrated key.
   if(record.legacy) localStorage.setItem('coopengine-payment-ack:'+intent.storageKey+':'+record.key,'acknowledged');
   localStorage.removeItem(intent.storageKey);
  }
 }
 notifyFinancialWrites();
}

export const FINANCIAL_WRITES_EVENT = 'coopengine-financial-writes';
function notifyFinancialWrites(): void {
 if (typeof window!=='undefined' && typeof window.dispatchEvent==='function') window.dispatchEvent(new Event(FINANCIAL_WRITES_EVENT));
}
/** Only records for the currently signed-in browser identity are exposed. Never offer discard. */
export function pendingFinancialWrites(): {storageKey:string;path:string;key:string;scope?:string;payload:string}[] {
 if (typeof window==='undefined' || !localStorage.getItem(SESSION_MARKER)) return [];
 const identity=financialBrowserIdentity(localStorage.getItem(USER_KEY));
 if (!identity) return [];
 const prefix='coopengine-payment:'+identity+':';
 const result=[];
 for(let i=0;i<localStorage.length;i++) {
  const storageKey=localStorage.key(i);
  if (!storageKey?.startsWith(prefix)) continue;
  try {
   const record=JSON.parse(localStorage.getItem(storageKey)??'null');
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
