'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch, clearSession, readToken } from '../../lib/api';
import Nav from '../components/Nav';

interface SavingsProduct {
  id: string;
  code: string;
  name: string;
  interestRatePa: number;
  minDeposit: number;
  allowWithdrawal: boolean;
  status: string;
  accountCount: number;
}

interface LoanProduct {
  id: string;
  code: string;
  name: string;
  interestRatePa: number;
  interestMethod: string;
  multiplier: number;
  minPrincipal: number;
  maxPrincipal: number | null;
  status: string;
  loanCount: number;
}

export default function ProductsPage() {
  const router = useRouter();
  const [savings, setSavings] = useState<SavingsProduct[]>([]);
  const [loans, setLoans] = useState<LoanProduct[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newSavings, setNewSavings] = useState({ code: '', name: '', interestRatePa: '6', minDeposit: '0' });
  const [newLoan, setNewLoan] = useState({
    code: '',
    name: '',
    interestRatePa: '12',
    multiplier: '3',
    minPrincipal: '1000',
    maxPrincipal: '5000000',
  });

  const load = useCallback(async () => {
    const token = readToken();
    if (!token) {
      router.replace('/login');
      return;
    }
    try {
      const [s, l] = await Promise.all([
        apiFetch<SavingsProduct[]>('/products/savings', token),
        apiFetch<LoanProduct[]>('/products/loans', token),
      ]);
      setSavings(s);
      setLoans(l);
      setError(null);
    } catch (e) {
      if (String(e).includes('401')) {
        clearSession();
        router.replace('/login');
        return;
      }
      setError(e instanceof Error ? e.message : 'Failed to load products');
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createSavings() {
    const token = readToken();
    if (!token) return;
    setBusy(true);
    try {
      await apiFetch('/products/savings', token, {
        method: 'POST',
        body: JSON.stringify({
          code: newSavings.code.toUpperCase(),
          name: newSavings.name,
          interestRatePa: Number(newSavings.interestRatePa),
          minDeposit: Number(newSavings.minDeposit),
          allowWithdrawal: true,
        }),
      });
      setNewSavings({ code: '', name: '', interestRatePa: '6', minDeposit: '0' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  }

  async function createLoan() {
    const token = readToken();
    if (!token) return;
    setBusy(true);
    try {
      await apiFetch('/products/loans', token, {
        method: 'POST',
        body: JSON.stringify({
          code: newLoan.code.toUpperCase(),
          name: newLoan.name,
          interestRatePa: Number(newLoan.interestRatePa),
          interestMethod: 'FLAT',
          multiplier: Number(newLoan.multiplier),
          minPrincipal: Number(newLoan.minPrincipal),
          maxPrincipal: Number(newLoan.maxPrincipal),
        }),
      });
      setNewLoan({ code: '', name: '', interestRatePa: '12', multiplier: '3', minPrincipal: '1000', maxPrincipal: '5000000' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  }

  async function updateRate(kind: 'savings' | 'loans', product: SavingsProduct | LoanProduct, rate: number) {
    const token = readToken();
    if (!token) return;
    setBusy(true);
    try {
      const body =
        kind === 'savings'
          ? {
              code: (product as SavingsProduct).code,
              name: product.name,
              interestRatePa: rate,
              minDeposit: (product as SavingsProduct).minDeposit,
              allowWithdrawal: (product as SavingsProduct).allowWithdrawal,
            }
          : {
              code: (product as LoanProduct).code,
              name: product.name,
              interestRatePa: rate,
              interestMethod: (product as LoanProduct).interestMethod,
              multiplier: (product as LoanProduct).multiplier,
              minPrincipal: (product as LoanProduct).minPrincipal,
              maxPrincipal: (product as LoanProduct).maxPrincipal,
            };
      await apiFetch(`/products/${kind}/${product.id}`, token, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  }

  async function toggle(kind: 'savings' | 'loans', product: { id: string; status: string }) {
    const token = readToken();
    if (!token) return;
    setBusy(true);
    try {
      await apiFetch(`/products/${kind}/${product.id}/status`, token, {
        method: 'POST',
        body: JSON.stringify({ status: product.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Status change failed');
    } finally {
      setBusy(false);
    }
  }

  const cell: React.CSSProperties = { padding: '6px 10px', borderBottom: '1px solid #e6e9ee', fontSize: 14 };
  const input: React.CSSProperties = { padding: '6px 8px', border: '1px solid #cfd6de', borderRadius: 6, fontSize: 14 };

  return (
    <main style={{ maxWidth: 1000, margin: '0 auto', padding: 20 }}>
      <h1 style={{ marginBottom: 4 }}>Products</h1>
      <p style={{ color: '#5b6772', marginTop: 0 }}>
        Savings and loan products define the rates your cooperative offers.
      </p>
      <Nav />

      {error && (
        <p style={{ background: '#fdecea', color: '#8a1c1c', padding: 10, borderRadius: 6 }}>{error}</p>
      )}

      <section style={{ marginTop: 18 }}>
        <h2 style={{ fontSize: 16 }}>Savings products</h2>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#5b6772', fontSize: 13 }}>
              <th style={cell}>Code</th>
              <th style={cell}>Name</th>
              <th style={cell}>Rate % p.a.</th>
              <th style={cell}>Min deposit</th>
              <th style={cell}>Withdrawal</th>
              <th style={cell}>Accounts</th>
              <th style={cell}>Status</th>
              <th style={cell} />
            </tr>
          </thead>
          <tbody>
            {savings.map((p) => (
              <tr key={p.id}>
                <td style={cell}>{p.code}</td>
                <td style={cell}>{p.name}</td>
                <td style={cell}>
                  <input
                    style={{ ...input, width: 70 }}
                    defaultValue={String(p.interestRatePa)}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (v !== p.interestRatePa) void updateRate('savings', p, v);
                    }}
                  />
                </td>
                <td style={cell}>{p.minDeposit.toFixed(2)}</td>
                <td style={cell}>{p.allowWithdrawal ? 'Yes' : 'No'}</td>
                <td style={cell}>{p.accountCount}</td>
                <td style={cell}>{p.status}</td>
                <td style={cell}>
                  <button disabled={busy} onClick={() => void toggle('savings', p)}>
                    {p.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <input style={{ ...input, width: 120 }} placeholder="CODE" value={newSavings.code} onChange={(e) => setNewSavings({ ...newSavings, code: e.target.value })} />
          <input style={{ ...input, width: 200 }} placeholder="Name" value={newSavings.name} onChange={(e) => setNewSavings({ ...newSavings, name: e.target.value })} />
          <input style={{ ...input, width: 90 }} placeholder="Rate %" value={newSavings.interestRatePa} onChange={(e) => setNewSavings({ ...newSavings, interestRatePa: e.target.value })} />
          <input style={{ ...input, width: 120 }} placeholder="Min deposit" value={newSavings.minDeposit} onChange={(e) => setNewSavings({ ...newSavings, minDeposit: e.target.value })} />
          <button disabled={busy || !newSavings.code || !newSavings.name} onClick={() => void createSavings()}>
            Add savings product
          </button>
        </div>
      </section>

      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: 16 }}>Loan products</h2>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#5b6772', fontSize: 13 }}>
              <th style={cell}>Code</th>
              <th style={cell}>Name</th>
              <th style={cell}>Rate % p.a.</th>
              <th style={cell}>Method</th>
              <th style={cell}>Savings multiple</th>
              <th style={cell}>Min</th>
              <th style={cell}>Max</th>
              <th style={cell}>Loans</th>
              <th style={cell}>Status</th>
              <th style={cell} />
            </tr>
          </thead>
          <tbody>
            {loans.map((p) => (
              <tr key={p.id}>
                <td style={cell}>{p.code}</td>
                <td style={cell}>{p.name}</td>
                <td style={cell}>
                  <input
                    style={{ ...input, width: 70 }}
                    defaultValue={String(p.interestRatePa)}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (v !== p.interestRatePa) void updateRate('loans', p, v);
                    }}
                  />
                </td>
                <td style={cell}>{p.interestMethod}</td>
                <td style={cell}>{p.multiplier}x</td>
                <td style={cell}>{p.minPrincipal.toFixed(0)}</td>
                <td style={cell}>{p.maxPrincipal === null ? '—' : p.maxPrincipal.toFixed(0)}</td>
                <td style={cell}>{p.loanCount}</td>
                <td style={cell}>{p.status}</td>
                <td style={cell}>
                  <button disabled={busy} onClick={() => void toggle('loans', p)}>
                    {p.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <input style={{ ...input, width: 110 }} placeholder="CODE" value={newLoan.code} onChange={(e) => setNewLoan({ ...newLoan, code: e.target.value })} />
          <input style={{ ...input, width: 170 }} placeholder="Name" value={newLoan.name} onChange={(e) => setNewLoan({ ...newLoan, name: e.target.value })} />
          <input style={{ ...input, width: 80 }} placeholder="Rate %" value={newLoan.interestRatePa} onChange={(e) => setNewLoan({ ...newLoan, interestRatePa: e.target.value })} />
          <input style={{ ...input, width: 70 }} placeholder="x savings" value={newLoan.multiplier} onChange={(e) => setNewLoan({ ...newLoan, multiplier: e.target.value })} />
          <input style={{ ...input, width: 110 }} placeholder="Min principal" value={newLoan.minPrincipal} onChange={(e) => setNewLoan({ ...newLoan, minPrincipal: e.target.value })} />
          <input style={{ ...input, width: 120 }} placeholder="Max principal" value={newLoan.maxPrincipal} onChange={(e) => setNewLoan({ ...newLoan, maxPrincipal: e.target.value })} />
          <button disabled={busy || !newLoan.code || !newLoan.name} onClick={() => void createLoan()}>
            Add loan product
          </button>
        </div>
      </section>

      <p style={{ marginTop: 22 }}>
        <Link href="/">← Dashboard</Link>
      </p>
    </main>
  );
}
