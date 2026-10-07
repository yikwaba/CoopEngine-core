'use client';
import { useEffect, useState } from 'react';
import { apiFetch, FINANCIAL_WRITES_EVENT, pendingFinancialWrites, recoverFinancialWrite, syncFinancialWrites } from '../lib/api';

function description(path:string,payload:string):string {
 if(/^\/ledger\/journals\/[^/]+\/submit$/.test(path)) return 'Journal submission · '+path.split('/')[3];
 if(path==='/loans') return 'Loan application';
 if(path==='/ledger/journals') {try{return 'Journal draft · '+JSON.parse(payload).description;}catch{return 'Journal draft requiring review';}}
 if(path==='/payroll/import/preview') {try {return 'Payroll upload preview · '+JSON.parse(payload).filename;}catch{return 'Payroll upload requiring review';}}
 if(path==='/payroll/import/commit') {try {return 'Payroll submission · '+JSON.parse(payload).batchId;}catch{return 'Payroll submission requiring review';}}
 if(path==='/dividends/post') {try {const details=JSON.parse(payload);return 'Dividend · '+details.periodLabel+' · ₦'+details.distributableAmount;}catch{return 'Dividend requiring review';}}
 if(path==='/savings/interest/post') {try {return 'Savings interest · '+JSON.parse(payload).period;}catch{return 'Savings interest requiring review';}}
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
 const [created,setCreated]=useState<{path:string;id:string;status:string}|null>(null),[currentStatus,setCurrentStatus]=useState('');
 const [previewResult,setPreviewResult]=useState<{batchId:string;filename:string;totals:{totalRows:number;valid:number;invalid:number;totalAmount:number};errors:{row:number;reason:string}[]}|null>(null);
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
    setBusy(true);setMessage('Checking the original request…');setCreated(null);setCurrentStatus('');setPreviewResult(null);
    try {const result=await recoverFinancialWrite(record.storageKey);if(record.path==='/payroll/import/preview')setPreviewResult(result as NonNullable<typeof previewResult>);if(record.path==='/loans'||record.path==='/ledger/journals'||/^\/ledger\/journals\/[^/]+\/submit$/.test(record.path)){const entry=result as {id:string;status:string};setCreated({path:record.path.endsWith('/submit')?record.path.slice(0,-7):record.path,id:entry.id,status:entry.status});}setMessage('The original request has been acknowledged. Refresh the account view to see the current balance or status.');}
    catch(error){setMessage(error instanceof Error?error.message:'Recovery failed. The original request is retained.');}
    finally{setBusy(false);setPending(pendingFinancialWrites());}
   }}>Recover original request</button>
   {!record.scope && <p>This older request needs account review before another payment.</p>}
  </li>)}</ul>
  <p role="status">{message}</p>
  {created&&<section aria-label="Recovered creation"><p>Original record: {created.id} · Original status: {created.status}</p><button type="button" disabled={busy} onClick={()=>void apiFetch<{status:string;entry?:{status:string}}>(created.path+'/'+created.id).then(result=>setCurrentStatus(result.entry?.status??result.status)).catch(error=>setMessage(String(error)))}>Check current record</button>{currentStatus&&<p>Current status: {currentStatus}</p>}</section>}
  {previewResult&&<section aria-label="Recovered upload validation"><h3>Recovered upload validation</h3><p>{previewResult.filename} · Batch {previewResult.batchId}</p><p>{previewResult.totals.totalRows} rows · {previewResult.totals.valid} valid · {previewResult.totals.invalid} invalid · ₦{previewResult.totals.totalAmount}</p><ul>{previewResult.errors.map((issue,index)=><li key={index}>Row/reference {issue.row}: {issue.reason}</li>)}</ul><p>These are the original preview results. Refresh the payroll register for current batch status.</p></section>}
  {!pending.length && <button type="button" onClick={()=>{setMessage('');setPreviewResult(null);setCreated(null);setCurrentStatus('');}}>Close</button>}
 </aside>;
}
