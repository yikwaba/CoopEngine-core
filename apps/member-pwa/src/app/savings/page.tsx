'use client';
import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {apiFetch,downloadMemberPdf,readMemberToken,FINANCIAL_WRITES_EVENT,pendingFinancialWrites} from '../../lib/api';
import {memberMoney as money,withdrawalAmount} from '../../lib/withdrawal-money';
type Account={id:string;accountNo:string;balance:number;balanceDecimal:string;status:string;productName:string;allowWithdrawal:boolean};
type Movement={id:string;type:string;amount:number;amountDecimal:string;runningBalance:number;runningBalanceDecimal:string;description:string|null;date:string};
type Savings={accounts:Account[];totalBalance:number;totalBalanceDecimal:string;transactions:Movement[]};
type Withdrawal={id:string;accountId:string;amount:number;amountDecimal:string;description:string|null;status:string;requestedAt:string;decidedAt:string|null;decisionNotes:string|null;approvalStep:number|null;approvalTotalSteps:number|null;approvalStatus:string|null};
const day=(date:string)=>new Date(date).toLocaleDateString('en-NG',{day:'2-digit',month:'short',year:'numeric'});
function status(row:Withdrawal):string {
 if(row.status==='APPROVED')return 'Approved and paid';if(row.status==='REJECTED')return 'Rejected — no payout';if(row.status!=='PENDING')return 'Status requires review';
 if(row.approvalStatus&&row.approvalStatus!=='PENDING')return 'Awaiting cooperative review';
 return row.approvalStep&&row.approvalTotalSteps?`Awaiting approval · step ${row.approvalStep} of ${row.approvalTotalSteps}`:'Awaiting staff approval';
}
export default function SavingsPage(){
 const router=useRouter(),sequence=useRef(0),hadUnconfirmed=useRef(false);
 const [data,setData]=useState<Savings|null>(null),[requests,setRequests]=useState<Withdrawal[]|null>(null);
 const [error,setError]=useState(''),[submitError,setSubmitError]=useState(''),[notice,setNotice]=useState('');
 const [accountId,setAccountId]=useState(''),[amount,setAmount]=useState(''),[description,setDescription]=useState('');
 const [busy,setBusy]=useState(false),[downloadBusy,setDownloadBusy]=useState(false),[unconfirmed,setUnconfirmed]=useState(false);
 const load=useCallback(async()=>{
  if(!readMemberToken()){router.replace('/login');return;}const current=++sequence.current;
  const result=await Promise.allSettled([apiFetch<Savings>('/member/savings'),apiFetch<Withdrawal[]>('/member/withdrawals')]);
  if(current!==sequence.current)return;if(!readMemberToken()){router.replace('/login');return;}
  if(result[0].status==='fulfilled'){const savings=result[0].value;setData(savings);setAccountId(selected=>selected||savings.accounts.find(a=>a.status==='ACTIVE'&&a.allowWithdrawal)?.id||'');}
  if(result[1].status==='fulfilled')setRequests(result[1].value);
  setError(result.some(r=>r.status==='rejected')?'Some savings or withdrawal information could not be refreshed. Try Refresh savings and requests.':'');
 },[router]);
 useEffect(()=>{
  const refresh=()=>{const pending=pendingFinancialWrites().find(r=>r.path==='/member/withdrawals/request');setUnconfirmed(!!pending);if(!pending&&hadUnconfirmed.current){setAmount('');setDescription('');setNotice('Original withdrawal request acknowledged. Its current status is shown below.');}hadUnconfirmed.current=!!pending;if(pending){try{const original=JSON.parse(pending.payload);if(typeof original.accountId==='string')setAccountId(original.accountId);if(typeof original.amount==='number')setAmount(String(original.amount));if(typeof original.description==='string')setDescription(original.description);}catch{setSubmitError('The original request needs review. Its record is retained.');}}void load();};
  refresh();window.addEventListener(FINANCIAL_WRITES_EVENT,refresh);window.addEventListener('focus',refresh);window.addEventListener('storage',refresh);
  const timer=setInterval(()=>{if(document.visibilityState==='visible')void load();},15000);
  return()=>{sequence.current++;clearInterval(timer);window.removeEventListener(FINANCIAL_WRITES_EVENT,refresh);window.removeEventListener('focus',refresh);window.removeEventListener('storage',refresh);};
 },[load]);
 const eligible=data?.accounts.filter(a=>a.status==='ACTIVE'&&a.allowWithdrawal)??[],selected=eligible.some(a=>a.id===accountId);
 async function submit(event:FormEvent){
  event.preventDefault();setSubmitError('');setNotice('');if(!selected){setSubmitError('Choose an active account that allows withdrawals.');return;}setBusy(true);
  try{const value=withdrawalAmount(amount);await apiFetch('/member/withdrawals/request',undefined,{method:'POST',body:JSON.stringify({accountId,amount:value,description:description.trim()})});setNotice('Your withdrawal request was received. Its current status is shown below.');setAmount('');setDescription('');await load();}
  catch(e){setSubmitError(e instanceof Error?e.message:'Could not confirm your request. Recover the original request if it is listed below.');}
  finally{setBusy(false);setUnconfirmed(pendingFinancialWrites().some(r=>r.path==='/member/withdrawals/request'));}
 }
 async function download(){setDownloadBusy(true);try{await downloadMemberPdf('/member/statements/savings.pdf','savings-statement.pdf');}catch(e){setError(e instanceof Error?e.message:'Could not prepare the statement.');}finally{setDownloadBusy(false);}}
 return <main style={{maxWidth:720,margin:'0 auto',padding:20,overflowWrap:'anywhere'}}>
  <Link href='/'>← Back to dashboard</Link><h1>My savings</h1><p>Your balances, withdrawal requests and recent movements.</p>
  {error&&<p role='alert'>{error}</p>}<button type='button' onClick={()=>void load()}>Refresh savings and requests</button>
  <section className='card' style={{marginTop:16}} aria-label='Savings balances'><h2>Total savings</h2><strong className='stat-value'>{data?money(data.totalBalanceDecimal??data.totalBalance):'…'}</strong>
   {data?.accounts.map(a=><p key={a.id}>{a.productName} · {a.accountNo}: <strong>{money(a.balanceDecimal??a.balance)}</strong> · {a.status}</p>)}
   <button className='btn' type='button' disabled={downloadBusy} onClick={download}>{downloadBusy?'Preparing…':'Download statement (PDF)'}</button>
  </section>
  <section className='card' style={{marginTop:16}}><h2>Request a withdrawal</h2><p>Your cooperative must approve the request. Submitting it does not deduct your savings.</p>
   {submitError&&<p role='alert'>{submitError}</p>}{notice&&<p role='status'>{notice}</p>}
   {unconfirmed&&<p role='status'>Your previous withdrawal submission has not been acknowledged. Use Recover original request before submitting another withdrawal.</p>}
   {data&&eligible.length===0&&<p>No active account currently allows withdrawals. Contact your cooperative.</p>}
   <form onSubmit={submit} style={{display:'grid',gridTemplateColumns:'minmax(0,1fr)',gap:12}}>
    <div><label htmlFor='withdrawal-account'>Savings account</label><select id='withdrawal-account' className='field' style={{width:'100%',padding:12,maxWidth:'100%'}} value={accountId} onChange={e=>setAccountId(e.target.value)} disabled={busy||unconfirmed||!eligible.length} required><option value=''>Choose an account</option>{eligible.map(a=><option key={a.id} value={a.id}>{a.productName} · {a.accountNo} · {money(a.balanceDecimal??a.balance)}</option>)}</select></div>
    <label>Withdrawal amount (₦)<input className='field' inputMode='decimal' value={amount} onChange={e=>setAmount(e.target.value)} disabled={busy||unconfirmed} maxLength={24} required placeholder='1.00'/></label>
    <label>Reason for withdrawal<input className='field' value={description} onChange={e=>setDescription(e.target.value)} disabled={busy||unconfirmed} maxLength={240}/></label>
    <button className='btn' disabled={busy||unconfirmed||!selected}>{busy?'Sending request…':'Submit withdrawal request'}</button>
   </form>
  </section>
  <section style={{marginTop:20}} aria-label='Withdrawal requests'><h2>My withdrawal requests</h2><p>Showing up to 200 most recent requests. Status refreshes while this page is open.</p>
   {requests===null?<p>Withdrawal requests have not loaded.</p>:requests.length===0?<p>No withdrawal requests yet.</p>:requests.map(r=><article className='card' key={r.id} style={{marginTop:12}} aria-label={r.description||'Withdrawal request'}><h3>{r.description||'Withdrawal request'}</h3><p>{money(r.amountDecimal??r.amount)} · {data?.accounts.find(a=>a.id===r.accountId)?.accountNo??'Savings account'}</p><p><strong>{status(r)}</strong></p><p>Requested {day(r.requestedAt)}{r.decidedAt?` · Decided ${day(r.decidedAt)}`:''}</p>{r.decisionNotes&&<p>Cooperative note: {r.decisionNotes}</p>}</article>)}
  </section>
  <section style={{marginTop:20}}><h2>Recent movements</h2>{data&&data.transactions.length===0&&<p>No deposits or withdrawals yet.</p>}
   {data&&data.transactions.length>0&&<div style={{overflowX:'auto'}}><table style={{width:'100%',fontSize:14}}><thead><tr><th>Date</th><th>What</th><th>Amount</th><th>Balance</th></tr></thead><tbody>{data.transactions.map(t=><tr key={t.id}><td>{day(t.date)}</td><td>{t.description??t.type.replace(/_/g,' ').toLowerCase()}</td><td>{money(t.amountDecimal??t.amount)}</td><td>{money(t.runningBalanceDecimal??t.runningBalance)}</td></tr>)}</tbody></table></div>}
  </section>
 </main>;
}
