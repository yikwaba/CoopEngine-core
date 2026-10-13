'use client';
import ParkedPayments from '../../components/parked-payments';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {reportMoney} from '../../lib/report-money';
import { apiFetch, apiResponse, FINANCIAL_WRITES_EVENT, readToken } from '../../lib/api';

interface VirtualAccount {
  id: string;
  memberNo: number;
  member: string;
  provider: string;
  accountNumber: string;
  accountName: string;
  bankName: string;
  status: string;
}

interface PaymentFeedItem {
  id: string;
  accountNumber: string;
  paymentReference: string;
  amount: number;
  amountDecimal?: string;
  paidAt: string;
  status: string;
}

const paymentStatus=(status:string)=>({POSTED:'Allocated',PARKED:'Parked — awaiting allocation',FAILED:'Failed',REVIEW_REQUIRED:'Needs review'}[status]??status);

export default function CollectionsPage() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<VirtualAccount[]>([]);
  const [feed, setFeed] = useState<PaymentFeedItem[]>([]);
  const [feedTotal, setFeedTotal] = useState(0);
  const [memberId, setMemberId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const token = readToken();
    if (!token) {
      router.replace('/login');
      return;
    }
    try {
      const accs = await apiFetch<VirtualAccount[]>('/payments/virtual-accounts', token);
      const res = await apiResponse(`/payments/internal/notifications?limit=50`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const feedItems = (await res.json()) as PaymentFeedItem[];
      setAccounts(accs);
      setFeed(feedItems);
      setFeedTotal(Number(res.headers.get('x-total-count') ?? feedItems.length));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load collections');
    }
  }, [router]);

  useEffect(() => {
    const refresh=()=>{void load();};refresh();
    window.addEventListener(FINANCIAL_WRITES_EVENT,refresh);window.addEventListener('focus',refresh);
    return()=>{window.removeEventListener(FINANCIAL_WRITES_EVENT,refresh);window.removeEventListener('focus',refresh);};
  }, [load]);

  async function createAccount(): Promise<void> {
    const token = readToken();
    if (!token || !memberId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await apiFetch<VirtualAccount>('/payments/virtual-accounts', token, {
        method: 'POST',
        body: JSON.stringify({ memberId }),
      });
      setNotice(`Created ${created.bankName} account ${created.accountNumber} for ${created.member}.`);
      setMemberId('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Creation failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 1000, margin: '0 auto', padding: 28 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0 }}>Collections</h1>
        <Link href="/" style={{ fontSize: 14 }}>
          ← Dashboard
        </Link>
      </div>

      <button className="btn" style={{marginTop:14}} onClick={()=>void load()}>Refresh collections</button>

      {notice && <p style={{ background: '#ecfdf3', color: '#067647', borderRadius: 8, padding: '10px 12px', marginTop: 14 }}>{notice}</p>}
      {error && <p style={{ background: '#fdecea', color: '#b42318', borderRadius: 8, padding: '10px 12px', marginTop: 14 }}>{error}</p>}

      <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ margin: '0 0 10px', fontSize: 16 }}>Issue a virtual account</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            className="field"
            value={memberId}
            onChange={(e) => setMemberId(e.target.value)}
            placeholder="Member UUID (see Members → Open)"
            style={{ maxWidth: 320 }}
          />
          <button className="btn" disabled={busy || !memberId} onClick={() => void createAccount()}>
            Create
          </button>
        </div>
      </section>

      <section className="card" style={{ marginTop: 14 }}>
        <h2 style={{ margin: '0 0 10px', fontSize: 16 }}>Virtual accounts ({accounts.length})</h2>
        {accounts.length === 0 ? (
          <p style={{ color: '#5b6772' }}>None issued yet.</p>
        ) : (
          <div style={{overflowX:'auto'}}><table className="data">
            <thead>
              <tr>
                <th>Member</th>
                <th>Account number</th>
                <th>Bank</th>
                <th>Provider</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.member} (#{a.memberNo})
                  </td>
                  <td>
                    <strong>{a.accountNumber}</strong>
                  </td>
                  <td>{a.bankName}</td>
                  <td>{a.provider}</td>
                  <td>{a.status}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>

      <section className="card" style={{ marginTop: 14 }}>
        <h2 style={{ margin: '0 0 10px', fontSize: 16 }}>
          Inbound payments ({feed.length} shown of {feedTotal})
        </h2>
        {feed.length === 0 ? (
          <p style={{ color: '#5b6772' }}>No inbound payments yet.</p>
        ) : (
          <div style={{overflowX:'auto'}}><table className="data">
            <thead>
              <tr>
                <th>Account</th>
                <th>Reference</th>
                <th>Amount</th>
                <th>Paid</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {feed.map((p) => (
                <tr key={p.id} aria-label={`Payment reference ${p.paymentReference}`}>
                  <td>{p.accountNumber}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{p.paymentReference}</td>
                  <td>{reportMoney(p.amountDecimal??p.amount)}</td>
                  <td>{new Date(p.paidAt).toLocaleString()}</td>
                  <td>{paymentStatus(p.status)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
      <ParkedPayments />
    </main>
  );
}
