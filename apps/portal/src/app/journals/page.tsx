'use client';
import {useEffect,useState} from 'react';
import Link from 'next/link';
import {apiFetch} from '../../lib/api';
type JournalLine={accountCode:string;accountName:string;debitDecimal:string;creditDecimal:string};
type Journal={id:string;description:string;status:string;entryDate:string;source:string};
export default function Page(){
 const [rows,setRows]=useState<Journal[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[ack,setAck]=useState<Journal|null>(null),[current,setCurrent]=useState('');
 const [detail,setDetail]=useState<{entry:Journal;lines:JournalLine[]}|null>(null);
 async function refresh(){setRows(await apiFetch<Journal[]>('/ledger/journals?limit=200'));}
 useEffect(()=>{void refresh().catch(e=>setError(String(e)));},[]);
 async function submit(row:Journal){setBusy(true);setError('');setAck(null);setCurrent('');try{
  setAck(await apiFetch<Journal>('/ledger/journals/'+row.id+'/submit',undefined,{method:'POST',body:'{}'}));await refresh();
 }catch(e){setError(e instanceof Error?e.message:'Submission failed');}finally{setBusy(false);}}
 return <main style={{maxWidth:900,margin:'0 auto',padding:24,overflowWrap:'anywhere'}}><Link href='/'>← Dashboard</Link><h1>Journal submissions</h1><p><Link href='/journal-drafts'>Create a journal draft</Link></p><p>Submission sends a draft for review. It does not post money. If the result is uncertain, recover the original request before taking another action.</p><button disabled={busy} onClick={()=>void refresh().catch(e=>setError(String(e)))}>Refresh journals</button><p>Showing up to 200 most recent journals. Approval and posting remain separate review steps.</p>
 {error&&<p role='alert'>{error}</p>}{ack&&<section aria-label='Submission acknowledgement'><p role='status'>Original submission acknowledged: {ack.id}. Original status: {ack.status}.</p><button disabled={busy} onClick={()=>void apiFetch<{entry:Journal}>('/ledger/journals/'+ack.id).then(r=>setCurrent(r.entry.status)).catch(e=>setError(String(e)))}>Check current record</button>{current&&<p>Current status: {current}</p>}</section>}
 {detail&&<section aria-label='Journal lines'><h2>{detail.entry.description}: lines</h2>{detail.lines.map((line,index)=><p key={index}>{line.accountCode} — {line.accountName}: Debit ₦{line.debitDecimal}; Credit ₦{line.creditDecimal}</p>)}</section>}
 {rows.length===0&&<p>No journals loaded.</p>}{rows.map(row=><article key={row.id} className='card' style={{marginTop:12}} aria-label={row.description}><h2>{row.description}</h2><p>{row.entryDate} · {row.source} · <strong>{row.status}</strong></p><p>{row.id}</p><button disabled={busy} onClick={()=>void apiFetch<{entry:Journal;lines:JournalLine[]}>('/ledger/journals/'+row.id).then(setDetail).catch(e=>setError(String(e)))}>View lines {row.description}</button>{row.status==='DRAFT'&&<button disabled={busy} onClick={()=>void submit(row)}>Submit {row.description}</button>}</article>)}</main>;
}
