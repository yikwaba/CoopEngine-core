'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch, readMemberToken, clearMemberSession } from '../../lib/api';

interface LoanProduct {
  id: string;
  code: string;
  name: string;
  interestRatePa: number;
  interestMethod: string;
  multiplier: number;
  minPrincipal: number;
  maxPrincipal: number | null;
}

interface MyLoan {
  id: string;
  productCode: string;
  productName: string;
  principal: number;
  outstandingPrincipal: number;
  termMonths: number;
  status: string;
  nextDueDate: string | null;
  nextDueAmount: number;
}

const money = (n: number) =>
  `₦${n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function LoansPage() {
  const router = useRouter();
  const [products, setProducts] = useState<LoanProduct[]>([]);
  const [myLoans, setMyLoans] = useState<MyLoan[]>([]);
  const [productId, setProductId] = useState('');
  const [principal, setPrincipal] = useState('');
  const [termMonths, setTermMonths] = useState('3');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const token = readMemberToken();
    if (!token) {
      router.replace('/login');
      return;
    }
    try {
      const [p, l] = await Promise.all([
        apiFetch<LoanProduct[]>('/member/loan-products', token),
        apiFetch<MyLoan[]>('/member/loans', token),
      ]);
      setProducts(p);
      setMyLoans(l);
      const first = p[0];
      if (!productId && first) setProductId(first.id);
    } catch (e) {
      if (String(e).includes('401')) {
        clearMemberSession();
        router.replace('/login');
        return;
      }
      setError(e instanceof Error ? e.message : 'Could not load loans');
    }
  }, [router, productId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function apply() {
    const token = readMemberToken();
    if (!token || !productId) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await apiFetch('/member/loans/apply', token, {
        method: 'POST',
        body: JSON.stringify({
          loanProductId: productId,
          principal: Number(principal),
          termMonths: Number(termMonths),
        }),
      });
      setMessage('Application submitted — awaiting review.');
      setPrincipal('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Application failed');
    } finally {
      setBusy(false);
    }
  }

  const selected = products.find((p) => p.id === productId);

  return (
    <main style={{ maxWidth: 560, margin: '0 auto', padding: 18 }}>
      <h1 style={{ fontSize: 20, marginBottom: 2 }}>Loans</h1>
      <p style={{ color: '#5b6772', marginTop: 0, fontSize: 13 }}>Apply for a loan or track an existing one.</p>
      <p style={{ fontSize: 14 }}>
        <Link href="/">← Back to dashboard</Link>
      </p>

      {error && <p style={{ background: '#fdecea', color: '#8a1c1c', padding: 10, borderRadius: 8 }}>{error}</p>}
      {message && <p style={{ background: '#e7f6ec', color: '#0a6c2e', padding: 10, borderRadius: 8 }}>{message}</p>}

      <section style={{ border: '1px solid #e2e6eb', borderRadius: 12, padding: 14, marginTop: 10 }}>
        <h2 style={{ fontSize: 15, marginTop: 0 }}>New application</h2>
        <label style={{ display: 'block', fontSize: 13, color: '#5b6772' }}>Product</label>
        <select
          value={productId}
          onChange={(e) => setProductId(e.target.value)}
          style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid #cfd6de', marginBottom: 10 }}
        >
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} — {p.interestRatePa}% p.a. ({p.interestMethod.toLowerCase()})
            </option>
          ))}
        </select>

        <label style={{ display: 'block', fontSize: 13, color: '#5b6772' }}>Amount (₦)</label>
        <input
          inputMode="decimal"
          value={principal}
          onChange={(e) => setPrincipal(e.target.value)}
          style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid #cfd6de', marginBottom: 10 }}
        />

        <label style={{ display: 'block', fontSize: 13, color: '#5b6772' }}>Term (months)</label>
        <input
          inputMode="numeric"
          value={termMonths}
          onChange={(e) => setTermMonths(e.target.value)}
          style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid #cfd6de', marginBottom: 10 }}
        />

        {selected && (
          <p style={{ fontSize: 12, color: '#5b6772' }}>
            Limits: {money(selected.minPrincipal)}
            {selected.maxPrincipal ? ` – ${money(selected.maxPrincipal)}` : ''} · up to {selected.multiplier}x your savings
          </p>
        )}

        <button
          disabled={busy || !principal || !productId}
          onClick={() => void apply()}
          style={{
            width: '100%',
            padding: 12,
            borderRadius: 10,
            border: 'none',
            background: '#0a6c2e',
            color: '#fff',
            fontSize: 15,
          }}
        >
          {busy ? 'Submitting…' : 'Submit application'}
        </button>
      </section>

      <section style={{ marginTop: 18 }}>
        <h2 style={{ fontSize: 15 }}>My loans</h2>
        {myLoans.length === 0 && <p style={{ color: '#5b6772', fontSize: 14 }}>No loans yet.</p>}
        {myLoans.map((l) => (
          <div key={l.id} style={{ border: '1px solid #e2e6eb', borderRadius: 12, padding: 12, marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong style={{ fontSize: 14 }}>{l.productName}</strong>
              <span style={{ fontSize: 12, color: '#5b6772' }}>{l.status}</span>
            </div>
            <p style={{ margin: '6px 0', fontSize: 13 }}>
              Principal {money(l.principal)} · Outstanding {money(l.outstandingPrincipal)} · {l.termMonths} months
            </p>
            {l.nextDueDate && (
              <p style={{ margin: 0, fontSize: 13, color: '#0a6c2e' }}>
                Next due {new Date(l.nextDueDate).toLocaleDateString()} — {money(l.nextDueAmount)}
              </p>
            )}
          </div>
        ))}
      </section>
    </main>
  );
}
