'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch, clearSession, readToken, API_BASE, downloadPdf } from '../../lib/api';
import Nav from '../components/Nav';

interface BoardPack {
  membership: { active: number; pending: number; suspended: number; exited: number };
  savings: { accounts: number; totalBalance: number };
  shares: { holders: number; totalBalance: number };
  loans: { open: number; disbursedTotal: number; outstanding: number };
  collections: { count: number; total: number };
  dividends: { runs: number; totalDistributed: number };
  ledger: { entries: number; net: number };
}

interface Analytics {
  months: { month: string; disbursed: number; collected: number }[];
  parByProduct: {
    productCode: string;
    productName: string;
    loans: number;
    outstanding: number;
    par30: number;
    par90: number;
  }[];
  totals: { outstanding: number; par30: number; par90: number };
}

const money = (n: number) =>
  `₦${n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function downloadBoardPack(): Promise<void> {
  const token = readToken();
  if (!token) return;
  const res = await fetch(`${API_BASE}/reports/export/board-pack`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Board pack download failed (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `board-pack-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function AnalyticsPage() {
  const router = useRouter();
  const [pack, setPack] = useState<BoardPack | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const token = readToken();
    if (!token) {
      router.replace('/login');
      return;
    }
    try {
      const [p, a] = await Promise.all([
        apiFetch<BoardPack>('/reports/board-pack', token),
        apiFetch<Analytics>('/reports/portfolio-analytics?months=6', token),
      ]);
      setPack(p);
      setAnalytics(a);
      setError(null);
    } catch (e) {
      if (String(e).includes('401')) {
        clearSession();
        router.replace('/login');
        return;
      }
      setError(e instanceof Error ? e.message : 'Could not load analytics');
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  const maxFlow = Math.max(
    1,
    ...(analytics?.months.flatMap((m) => [m.disbursed, m.collected]) ?? [1]),
  );
  const card: React.CSSProperties = {
    border: '1px solid #e2e6eb',
    borderRadius: 12,
    padding: 14,
    minWidth: 150,
  };
  const cell: React.CSSProperties = { padding: '6px 10px', borderBottom: '1px solid #e6e9ee', fontSize: 14 };

  return (
    <main style={{ maxWidth: 1040, margin: '0 auto', padding: 20 }}>
      <h1 style={{ marginBottom: 4 }}>Analytics & board pack</h1>
      <p style={{ color: '#5b6772', marginTop: 0 }}>Portfolio health at a glance, ready for the board.</p>
      <Nav />
      <button
        type="button"
        className="btn secondary"
        style={{ marginTop: 10 }}
        title="Download this month's board pack as a PDF"
        onClick={() => {
          const period = new Date().toISOString().slice(0, 7);
          void downloadPdf(`/pdf/board-pack.pdf?period=${period}`, `board-pack-${period}.pdf`).catch(
            (e: unknown) => alert(e instanceof Error ? e.message : 'Download failed'),
          );
        }}
      >
        Board pack (PDF)
      </button>


      {error && <p style={{ background: '#fdecea', color: '#8a1c1c', padding: 10, borderRadius: 6 }}>{error}</p>}

      <div style={{ marginTop: 14 }}>
        <button
          onClick={() =>
            void downloadBoardPack().catch((e) =>
              setError(e instanceof Error ? e.message : 'Download failed'),
            )
          }
        >
          Download board pack (CSV)
        </button>
      </div>

      {pack && (
        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, marginTop: 18 }}>
          <div style={card}>
            <p style={{ margin: 0, color: '#5b6772', fontSize: 13 }}>Members (active)</p>
            <strong style={{ fontSize: 20 }}>{pack.membership.active}</strong>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: '#5b6772' }}>
              {pack.membership.pending} pending · {pack.membership.exited} exited
            </p>
          </div>
          <div style={card}>
            <p style={{ margin: 0, color: '#5b6772', fontSize: 13 }}>Savings book</p>
            <strong style={{ fontSize: 18 }}>{money(pack.savings.totalBalance)}</strong>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: '#5b6772' }}>{pack.savings.accounts} active accounts</p>
          </div>
          <div style={card}>
            <p style={{ margin: 0, color: '#5b6772', fontSize: 13 }}>Share capital</p>
            <strong style={{ fontSize: 18 }}>{money(pack.shares.totalBalance)}</strong>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: '#5b6772' }}>{pack.shares.holders} holders</p>
          </div>
          <div style={card}>
            <p style={{ margin: 0, color: '#5b6772', fontSize: 13 }}>Loan portfolio</p>
            <strong style={{ fontSize: 18 }}>{money(pack.loans.outstanding)}</strong>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: '#5b6772' }}>
              {pack.loans.open} open · disbursed {money(pack.loans.disbursedTotal)}
            </p>
          </div>
          <div style={card}>
            <p style={{ margin: 0, color: '#5b6772', fontSize: 13 }}>Collections</p>
            <strong style={{ fontSize: 18 }}>{money(pack.collections.total)}</strong>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: '#5b6772' }}>{pack.collections.count} payments</p>
          </div>
          <div style={card}>
            <p style={{ margin: 0, color: '#5b6772', fontSize: 13 }}>Dividends paid</p>
            <strong style={{ fontSize: 18 }}>{money(pack.dividends.totalDistributed)}</strong>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: '#5b6772' }}>{pack.dividends.runs} runs</p>
          </div>
          <div style={card}>
            <p style={{ margin: 0, color: '#5b6772', fontSize: 13 }}>Trial balance</p>
            <strong style={{ fontSize: 18 }}>{money(pack.ledger.net)}</strong>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: '#5b6772' }}>{pack.ledger.entries} posted entries</p>
          </div>
        </section>
      )}

      {analytics && (
        <>
          <section style={{ marginTop: 24 }}>
            <h2 style={{ fontSize: 16 }}>Disbursements vs collections (6 months)</h2>
            {analytics.months.map((m) => (
              <div key={m.month} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <span style={{ width: 70, fontSize: 13, color: '#5b6772' }}>{m.month}</span>
                <div style={{ flex: 1 }}>
                  <div
                    style={{
                      height: 10,
                      width: `${(m.disbursed / maxFlow) * 100}%`,
                      background: '#1d4ed8',
                      borderRadius: 6,
                    }}
                  />
                  <div
                    style={{
                      height: 10,
                      width: `${(m.collected / maxFlow) * 100}%`,
                      background: '#0a6c2e',
                      borderRadius: 6,
                      marginTop: 3,
                    }}
                  />
                </div>
                <span style={{ fontSize: 12, color: '#5b6772', width: 190, textAlign: 'right' }}>
                  out {money(m.disbursed)} · in {money(m.collected)}
                </span>
              </div>
            ))}
          </section>

          <section style={{ marginTop: 24 }}>
            <h2 style={{ fontSize: 16 }}>Portfolio at risk by product</h2>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: '#5b6772', fontSize: 13 }}>
                  <th style={cell}>Product</th>
                  <th style={cell}>Loans</th>
                  <th style={cell}>Outstanding</th>
                  <th style={cell}>PAR 30+</th>
                  <th style={cell}>PAR 90+</th>
                </tr>
              </thead>
              <tbody>
                {analytics.parByProduct.map((p) => (
                  <tr key={p.productCode}>
                    <td style={cell}>
                      {p.productCode} — {p.productName}
                    </td>
                    <td style={cell}>{p.loans}</td>
                    <td style={cell}>{money(p.outstanding)}</td>
                    <td style={cell}>{money(p.par30)}</td>
                    <td style={cell}>{money(p.par90)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ fontSize: 13, color: '#5b6772' }}>
              Portfolio {money(analytics.totals.outstanding)} · PAR30 {money(analytics.totals.par30)} · PAR90{' '}
              {money(analytics.totals.par90)}
            </p>
          </section>
        </>
      )}

      <p style={{ marginTop: 22 }}>
        <Link href="/">← Dashboard</Link>
      </p>
    </main>
  );
}
