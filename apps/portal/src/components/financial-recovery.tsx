'use client';
import { useEffect, useState } from 'react';
import { FINANCIAL_WRITES_EVENT, pendingFinancialWrites, recoverFinancialWrite, syncFinancialWrites } from '../lib/api';

function description(path:string,payload:string):string {
 const action=path.split('/').at(-1)??'request';
 const names:Record<string,string>={deposits:'Savings deposit',withdrawals:'Savings withdrawal',repayments:'Loan repayment',purchases:'Share purchase',redemptions:'Share redemption',request:'Withdrawal request',approve:'Approval',reject:'Rejection',disburse:'Loan disbursement',reverse:'Reversal','approve-post':'Journal approval',decisions:'Approval decision'};
 let amount:unknown;try {amount=JSON.parse(payload).amount;}catch{return 'Financial request requiring review';}
 return (names[action]??'Financial request')+(typeof amount==='number'||typeof amount==='string'?` · NGN ${amount}`:'');
}
/** Recovery always uses the stored original request; no discard or replacement action. */
export default function FinancialRecovery() {
 const [pending,setPending]=useState<ReturnType<typeof pendingFinancialWrites>>([]);
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState('');
 useEffect(()=>{
  const refresh=()=>{void syncFinancialWrites().then(()=>setPending(pendingFinancialWrites())).catch(error=>setMessage(error instanceof Error?error.message:'Financial recovery storage is unavailable. Recover with the original key.'));};
  refresh();window.addEventListener(FINANCIAL_WRITES_EVENT,refresh);window.addEventListener('focus',refresh);window.addEventListener('storage',refresh);
  return()=>{window.removeEventListener(FINANCIAL_WRITES_EVENT,refresh);window.removeEventListener('focus',refresh);window.removeEventListener('storage',refresh);};
 },[]);
 if (!pending.length && !message) return null;
 return <aside aria-label="Financial request recovery" style={{position:'fixed',bottom:16,right:16,maxWidth:420,maxHeight:'60vh',overflow:'auto',padding:20,background:'#fff',color:'#172b3a',border:'2px solid #b7791f',borderRadius:12,zIndex:40,boxShadow:'0 4px 20px #0002'}}>
  <h2>Financial requests to check</h2>
  {pending.length>0 && <p>These requests have no acknowledged result. They are retained in this browser across tabs and restarts. Sign in to the original account to recover them. Do not clear browser data while a request is unresolved. Recover the original request before submitting another payment. A retry may complete a request that was never posted.</p>}
  <ul>{pending.map(record=><li key={record.storageKey} style={{marginBottom:12}}>
   <p>{description(record.path,record.payload)}</p>
   <button type="button" disabled={busy || !record.scope} onClick={async()=>{
    setBusy(true);setMessage('Checking the original request…');
    try {await recoverFinancialWrite(record.storageKey);setMessage('The original request has been acknowledged. Refresh the account view to see the current balance or status.');}
    catch(error){setMessage(error instanceof Error?error.message:'Recovery failed. The original request is retained.');}
    finally{setBusy(false);setPending(pendingFinancialWrites());}
   }}>Recover original request</button>
   {!record.scope && <p>This older request needs account review before another payment.</p>}
  </li>)}</ul>
  <p role="status">{message}</p>
  {!pending.length && <button type="button" onClick={()=>setMessage('')}>Close</button>}
 </aside>;
}
