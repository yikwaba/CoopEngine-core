'use client';
import {useEffect,useState} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {apiFetch,readToken} from '../../lib/api';
interface Batch {id:string;filename:string;status:string;valid_rows:number;total_amount:string}
export default function PayrollPage(){
 const router=useRouter(),[batches,setBatches]=useState<Batch[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
 async function refresh(){const token=readToken();if(!token){router.replace('/login');return;}setBatches(await apiFetch<Batch[]>('/payroll/batches',token));}
 useEffect(()=>{void refresh().catch(err=>setError(err instanceof Error?err.message:'Cannot load batches'));},[]);
 async function submit(batch:Batch){const token=readToken();if(!token)return;if(!confirm('Submit '+batch.filename+' for approval? Submission does not post money.'))return;setBusy(true);setError(null);setNotice(null);try{await apiFetch('/payroll/import/commit',token,{method:'POST',body:JSON.stringify({batchId:batch.id})});setNotice('The original submission was acknowledged. The register shows the current batch status; a different user must approve posting.');await refresh();}catch(err){setError(err instanceof Error?err.message:'Submission failed');}finally{setBusy(false);}}
 return <main style={{maxWidth:1000,padding:28,margin:'0 auto'}}><Link href='/'>← Dashboard</Link><h1>Payroll submissions</h1><p>Review prepared payroll batches and submit them for approval. Submission does not move money. A different user must approve posting.</p><button className='btn secondary' disabled={busy} onClick={()=>void refresh().catch(err=>setError(String(err)))}>Refresh batches</button>{error&&<p role='alert'>{error}</p>}{notice&&<p role='status'>{notice}</p>}<div className='card' style={{overflowX:'auto',marginTop:16}}>{batches.length===0?<p>No prepared payroll batches.</p>:<table className='data'><thead><tr><th>File</th><th>Status</th><th>Valid rows</th><th>Total (₦)</th><th>Action</th></tr></thead><tbody>{batches.map(batch=><tr key={batch.id}><td>{batch.filename}</td><td>{batch.status}</td><td>{batch.valid_rows}</td><td>{batch.total_amount}</td><td>{batch.status==='PREVIEWED'?<button className='btn' disabled={busy} aria-label={'Submit '+batch.filename} onClick={()=>void submit(batch)}>Submit for approval</button>:'—'}</td></tr>)}</tbody></table>}</div></main>;
}
