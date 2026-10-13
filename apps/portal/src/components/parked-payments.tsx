'use client';
import {useCallback,useEffect,useState} from 'react';
import {apiFetch,FINANCIAL_WRITES_EVENT,pendingFinancialWrites,readToken} from '../lib/api';
import {reportMoney} from '../lib/report-money';

type Purpose='SAVINGS_DEPOSIT'|'LOAN_REPAYMENT'|'SHARE_PURCHASE';
interface Receipt {id:string;provider_reference:string;amount:string;exception_reason:string;member_id:string|null;member:string|null;member_no:number|null;payment_intent_id:string|null;intent_reference:string|null;intent_purpose:Purpose|null;intent_status:string|null}
interface Intent {id:string;reference:string;member_id:string;member:string;purpose:Purpose;status:string;received_amount:string;expected_amount:string}
interface Member {id:string;memberNo:number;firstName:string;lastName:string;status:string}
const purposes:Record<Purpose,string>={SAVINGS_DEPOSIT:'Savings deposit',LOAN_REPAYMENT:'Loan repayment',SHARE_PURCHASE:'Share purchase'};
export default function ParkedPayments(){
 const [receipts,setReceipts]=useState<Receipt[]>([]),[intents,setIntents]=useState<Intent[]>([]),[members,setMembers]=useState<Member[]>([]);
 const [selected,setSelected]=useState(''),[memberId,setMemberId]=useState(''),[purpose,setPurpose]=useState<Purpose>('SAVINGS_DEPOSIT'),[intentId,setIntentId]=useState(''),[query,setQuery]=useState('');
 const [canAssign,setCanAssign]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[pending,setPending]=useState<ReturnType<typeof pendingFinancialWrites>>([]);
 const receipt=receipts.find(r=>r.id===selected),path=`/payments/exceptions/${selected}/assign`,unconfirmed=pending.some(r=>r.path===path),linked=!!receipt?.payment_intent_id;
 const load=useCallback(async()=>{
  const token=readToken();if(!token)return;
  const me=await apiFetch<{permissions:string[]}>('/auth/me',token);
  setCanAssign(me.permissions.some(p=>['payments.reconcile','savings.post'].includes(p)));
  const rows=await apiFetch<Receipt[]>('/payments/exceptions',token);setReceipts(rows);
 },[]);
 useEffect(()=>{const refresh=()=>{setPending(pendingFinancialWrites());void load().catch(e=>setError(e instanceof Error?e.message:'Could not load parked payments.'));};refresh();window.addEventListener(FINANCIAL_WRITES_EVENT,refresh);window.addEventListener('storage',refresh);window.addEventListener('focus',refresh);return()=>{window.removeEventListener(FINANCIAL_WRITES_EVENT,refresh);window.removeEventListener('storage',refresh);window.removeEventListener('focus',refresh);};},[load]);
 useEffect(()=>{let cancelled=false;setIntents([]);if(!memberId)return;void apiFetch<Intent[]>(`/payments/intents?memberId=${encodeURIComponent(memberId)}&limit=200`,readToken()??undefined).then(rows=>{if(!cancelled)setIntents(rows);}).catch(e=>{if(!cancelled)setError(e instanceof Error?e.message:'Could not load payment intents.');});return()=>{cancelled=true;};},[memberId,selected,receipts]);
 function choose(id:string){const row=receipts.find(r=>r.id===id);setSelected(id);setMemberId(row?.member_id??'');setPurpose(row?.intent_purpose??'SAVINGS_DEPOSIT');setIntentId(row?.payment_intent_id??'');setMembers([]);setError('');setNotice('');}
 async function search(){setError('');try{setMembers(await apiFetch<Member[]>(`/members?q=${encodeURIComponent(query)}&limit=50`,readToken()??undefined));}catch(e){setError(e instanceof Error?e.message:'Could not search members.');}}
 async function assign(){if(!receipt||!memberId||busy||unconfirmed||!canAssign)return;setBusy(true);setError('');setNotice('');try{
  // Known links use the server-retained intent; explicit selection binds unlinked receipts.
  await apiFetch(path,readToken()??undefined,{method:'POST',body:JSON.stringify({memberId,purpose,...(!linked&&intentId?{paymentIntentId:intentId}:{})})});
  setNotice(`Payment ${receipt.provider_reference} allocated. ${linked||intentId?'Payment-intent progress updated.':'No payment intent selected.'}`);setSelected('');await load();
 }catch(e){setError(e instanceof Error?e.message:'Assignment failed. Recover the original request if its result is uncertain.');}finally{setBusy(false);}}
 const eligible=intents.filter(i=>i.purpose===purpose&&['OPEN','PARTIAL','MATCHED'].includes(i.status));
 return <section className="card" aria-label="Parked payments" style={{marginTop:14,overflowWrap:'anywhere'}}>
  <h2>Parked payments</h2><p>These receipts remain in suspense until assigned. A linked payment intent must retain its member and purpose. Unlinked receipts can be assigned with an explicitly selected intent or without one.</p>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <button className="btn" onClick={()=>void load().catch(e=>setError(String(e)))}>Refresh parked payments</button>
  <label style={{display:'block'}}>Parked receipt <select className="field" aria-label="Parked receipt" style={{maxWidth:'100%'}} value={selected} disabled={busy||unconfirmed} onChange={e=>choose(e.target.value)}><option value="">Select a receipt ({receipts.length} shown, latest 200)</option>{receipts.map(r=><option key={r.id} value={r.id}>{r.provider_reference} · {reportMoney(r.amount)}</option>)}</select></label>
  {receipt&&<><p>{receipt.exception_reason}</p>{linked&&<p>Linked intent: <strong>{receipt.intent_reference??'Unavailable'}</strong> · {receipt.intent_status} · {receipt.member} (#{receipt.member_no})</p>}
   {canAssign?<div className="stack">
    {!linked&&<><label>Find member <input className="field" aria-label="Find allocation member" value={query} onChange={e=>setQuery(e.target.value)} disabled={busy||unconfirmed}/></label><button className="btn" onClick={()=>void search()} disabled={busy||unconfirmed}>Search members</button></>}
    <label>Member <select className="field" aria-label="Allocation member" value={memberId} disabled={linked||busy||unconfirmed} onChange={e=>{setMemberId(e.target.value);setIntentId('');}}><option value="">Select a member</option>{receipt.member_id&&!members.some(m=>m.id===receipt.member_id)&&<option value={receipt.member_id}>{receipt.member} (#{receipt.member_no})</option>}{members.filter(m=>m.status==='ACTIVE').map(m=><option key={m.id} value={m.id}>{m.firstName} {m.lastName} (#{m.memberNo})</option>)}</select></label>
    <label>Purpose <select className="field" aria-label="Allocation purpose" value={purpose} disabled={linked||busy||unconfirmed} onChange={e=>{setPurpose(e.target.value as Purpose);setIntentId('');}}>{Object.entries(purposes).map(([value,name])=><option key={value} value={value}>{name}</option>)}</select></label>
    <label>Payment intent <select className="field" aria-label="Allocation payment intent" value={intentId} disabled={linked||!memberId||busy||unconfirmed} onChange={e=>setIntentId(e.target.value)}><option value="">No payment intent</option>{linked&&!eligible.some(i=>i.id===intentId)&&<option value={intentId}>{receipt.intent_reference??'Linked intent unavailable'}</option>}{eligible.map(i=><option key={i.id} value={i.id}>{i.reference} · {i.status} · {reportMoney(i.received_amount)} of {reportMoney(i.expected_amount)}</option>)}</select></label>
    {unconfirmed?<p>The original assignment has an unconfirmed result. Use Financial request recovery above before changing its details.</p>:<button className="btn" disabled={busy||!memberId} onClick={()=>void assign()}>Assign parked payment</button>}
   </div>:<p>Your role can view these receipts but cannot assign payments.</p>}
  </>}
  {intents.length>0&&<><h3>Payment intents for selected member (latest 200)</h3><div style={{overflowX:'auto'}}><table className="data"><thead><tr><th>Reference</th><th>Purpose</th><th>Received</th><th>Expected</th><th>Status</th></tr></thead><tbody>{intents.map(i=><tr key={i.id} aria-label={`Payment intent ${i.reference}`}><td>{i.reference}</td><td>{purposes[i.purpose]}</td><td>{reportMoney(i.received_amount)}</td><td>{reportMoney(i.expected_amount)}</td><td>{i.status}</td></tr>)}</tbody></table></div></>}
 </section>;
}
