'use client';
import {reportMoney} from '../../lib/report-money';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch, apiResponse, readToken, downloadPdf } from '../../lib/api';
import Nav from '../components/Nav';

interface BoardPack {
  membership: { active: number; pending: number; suspended: number; exited: number };
  savings: { accounts: number; totalBalance: number; totalBalanceDecimal?: string };
  shares: { holders: number; totalBalance: number; totalBalanceDecimal?: string };
  loans: { open: number; disbursedTotal: number; disbursedTotalDecimal?: string; outstanding: number; outstandingDecimal?: string };
  collections: { count: number; total: number; totalDecimal?: string };
  dividends: { runs: number; totalDistributed: number; totalDistributedDecimal?: string };
  ledger: { entries: number; net: number; netDecimal?: string };
}

interface Analytics {
  months: { month: string; disbursed: number; disbursedDecimal?: string; collected: number; collectedDecimal?: string }[];
  parByProduct: {
    productCode: string;
    productName: string;
    loans: number;
    outstanding: number; outstandingDecimal?: string;
    par30: number; par30Decimal?: string;
    par90: number; par90Decimal?: string;
  }[];
  totals: { outstanding: number; outstandingDecimal?: string; par30: number; par30Decimal?: string; par90: number; par90Decimal?: string };
}

interface SavingsReconciliation {
  checked: number; matched: number; balanced: boolean;
  unresolvedAccounts: number; unresolvedEntries: number;
  mismatches: unknown[];
  totals: {projectedDecimal: string; ledgerDecimal: string; diffDecimal: string; unallocatedLedgerDecimal: string};
  rows: {accountId: string; accountNo: number; memberNo: number; productCode: string;
    projectedDecimal: string; ledgerDecimal: string | null; diffDecimal: string | null; status: string; attribution: string[]}[];
  unresolved: {entryId: string; entryNo: number | null; memberNo: number | null; reason: string}[];
}
const reconciliationBasis: Record<string,string> = {SOURCE_ACCOUNT:'Journal account', LINKED_TRANSACTIONS:'Journal-checked transactions', SINGLE_ACCOUNT_MEMBER:'Member’s only account'};
const reconciliationReasons: Record<string,string> = {
  MEMBER_LIABILITY_WITHOUT_ACCOUNT_ALLOCATION: 'The member journal does not identify which savings account received the amount.',
  MOVEMENT_LEDGER_DISAGREEMENT: 'Savings transactions and the journal amount disagree.',
  SOURCE_ACCOUNT_CONFLICT: 'The journal account and its savings transactions disagree.',
  LIABILITY_WITHOUT_MEMBER_ACCOUNT: 'Savings liability is missing a valid member account.',
  MOVEMENT_WITHOUT_POSTED_LIABILITY: 'A savings transaction has no posted savings liability entry.',
  MOVEMENT_NOT_POSTED: 'A savings transaction is linked to an unposted journal.',
  REVERSED_WITHOUT_REVERSAL: 'The reversed journal has no matching counter-entry.',
  REVERSAL_WITHOUT_ORIGINAL: 'The reversal has no original savings liability entry.',
};

const money = reportMoney;

async function downloadBoardPack(kind:'csv'|'xlsx'='csv'): Promise<void> {
  const token = readToken();
  if (!token) return;
  const res = await apiResponse(kind==='xlsx'?'/reports/board-pack.xlsx':'/reports/export/board-pack');
  if (!res.ok) throw new Error(`Board pack download failed (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `board-pack-${new Date().toISOString().slice(0, 10)}.${kind}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function AnalyticsPage() {
  const router = useRouter();
  const [pack, setPack] = useState<BoardPack | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [reconciliation, setReconciliation] = useState<SavingsReconciliation | null>(null);
  const [reconciliationError, setReconciliationError] = useState<string | null>(null);
  const [reconciliationBusy, setReconciliationBusy] = useState(false);
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
        return;
      }
      setError(e instanceof Error ? e.message : 'Could not load analytics');
    }
  }, [router]);

  const reloadReconciliation = useCallback(async () => {
    const token = readToken();
    if (!token) return;
    setReconciliationBusy(true);
    setReconciliationError(null);
    try { setReconciliation(await apiFetch<SavingsReconciliation>('/reports/savings-reconciliation', token)); }
    catch (e) { setReconciliation(null); setReconciliationError(e instanceof Error ? e.message : 'Could not load savings reconciliation'); }
    finally { setReconciliationBusy(false); }
  }, []);

  useEffect(() => {
    void load();
    void reloadReconciliation();
  }, [load, reloadReconciliation]);

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
    <main style={{ maxWidth: 1040, margin: '0 auto', padding: 20, overflowWrap:'anywhere' }}>
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


      <section aria-labelledby="savings-reconciliation-title" style={{marginTop:20, padding:14, border:'1px solid #e2e6eb', borderRadius:12}}>
        <h2 id="savings-reconciliation-title">Savings reconciliation</h2>
        <p>Each savings product is checked separately. Posted originals and their reversal entries are both included. Account attribution is shown below; unallocated journals require review.</p>
        <button type="button" className="btn secondary" disabled={reconciliationBusy} onClick={() => void reloadReconciliation()}>
          {reconciliationBusy ? 'Checking savings…' : 'Refresh reconciliation'}
        </button>
        {reconciliationError && <p role="alert">{reconciliationError}</p>}
        {reconciliation && <>
          <p role="status"><strong>{reconciliation.balanced === true ? 'Savings reconciled' : 'Savings review required'}</strong> · Matched {reconciliation.matched} of {reconciliation.checked} accounts · {reconciliation.mismatches.length} balance differences · {reconciliation.unresolvedAccounts} unresolved accounts</p>
          <p>Projected: {money(reconciliation.totals.projectedDecimal)} · Ledger: {money(reconciliation.totals.ledgerDecimal)} · Difference: {money(reconciliation.totals.diffDecimal)}</p>
          {reconciliation.unresolvedEntries > 0 && <p>Unresolved journals: {reconciliation.unresolvedEntries}. Unallocated ledger amount: {money(reconciliation.totals.unallocatedLedgerDecimal)}. A matching combined total does not clear an unresolved product allocation.</p>}
          <div style={{overflowX:'auto',maxWidth:'100%'}}>
            <table style={{width:'100%',borderCollapse:'collapse'}}>
              <thead><tr>{['Account / member','Product','Projected','Ledger','Difference','Basis','Result'].map(label=><th key={label} style={cell}>{label}</th>)}</tr></thead>
              <tbody>{reconciliation.rows.map(row=><tr key={row.accountId}>
                <td style={cell}>#{row.accountNo} / member {row.memberNo}</td><td style={cell}>{row.productCode}</td>
                <td style={cell}>{money(row.projectedDecimal)}</td><td style={cell}>{row.ledgerDecimal === null ? 'Unresolved' : money(row.ledgerDecimal)}</td>
                <td style={cell}>{row.diffDecimal === null ? '—' : money(row.diffDecimal)}</td><td style={cell}>{row.attribution.length ? row.attribution.map(basis=>reconciliationBasis[basis] ?? basis).join(', ') : 'No attributed movements'}</td><td style={cell}>{row.status === 'MATCHED' ? 'Matched' : row.status === 'MISMATCH' ? 'Difference' : 'Unresolved'}</td>
              </tr>)}</tbody>
            </table>
          </div>
          {reconciliation.unresolved.length > 0 && <ul>{reconciliation.unresolved.map((issue,index)=><li key={`${issue.entryId}-${index}`}>
            {issue.entryNo === null ? 'Journal unavailable' : `Journal #${issue.entryNo}`}{issue.memberNo === null ? '' : ` · member ${issue.memberNo}`}: {reconciliationReasons[issue.reason] ?? 'Review this journal’s savings account allocation.'}
          </li>)}</ul>}
        </>}
      </section>

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
        <button onClick={()=>void downloadBoardPack('xlsx').catch(e=>setError(e instanceof Error?e.message:'Download failed'))}>Download board pack (Excel)</button><p style={{fontSize:12}}>Excel monetary values use exact decimal text to preserve every kobo.</p>
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
            <strong style={{ fontSize: 18 }}>{money(pack.savings.totalBalanceDecimal ?? pack.savings.totalBalance)}</strong>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: '#5b6772' }}>{pack.savings.accounts} active accounts</p>
          </div>
          <div style={card}>
            <p style={{ margin: 0, color: '#5b6772', fontSize: 13 }}>Share capital</p>
            <strong style={{ fontSize: 18 }}>{money(pack.shares.totalBalanceDecimal ?? pack.shares.totalBalance)}</strong>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: '#5b6772' }}>{pack.shares.holders} holders</p>
          </div>
          <div style={card}>
            <p style={{ margin: 0, color: '#5b6772', fontSize: 13 }}>Loan portfolio</p>
            <strong style={{ fontSize: 18 }}>{money(pack.loans.outstandingDecimal ?? pack.loans.outstanding)}</strong>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: '#5b6772' }}>
              {pack.loans.open} open · disbursed {money(pack.loans.disbursedTotalDecimal ?? pack.loans.disbursedTotal)}
            </p>
          </div>
          <div style={card}>
            <p style={{ margin: 0, color: '#5b6772', fontSize: 13 }}>Collections</p>
            <strong style={{ fontSize: 18 }}>{money(pack.collections.totalDecimal ?? pack.collections.total)}</strong>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: '#5b6772' }}>{pack.collections.count} payments</p>
          </div>
          <div style={card}>
            <p style={{ margin: 0, color: '#5b6772', fontSize: 13 }}>Dividends paid</p>
            <strong style={{ fontSize: 18 }}>{money(pack.dividends.totalDistributedDecimal ?? pack.dividends.totalDistributed)}</strong>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: '#5b6772' }}>{pack.dividends.runs} runs</p>
          </div>
          <div style={card}>
            <p style={{ margin: 0, color: '#5b6772', fontSize: 13 }}>Trial balance</p>
            <strong style={{ fontSize: 18 }}>{money(pack.ledger.netDecimal ?? pack.ledger.net)}</strong>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: '#5b6772' }}>{pack.ledger.entries} ledger entries</p>
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
                  out {money(m.disbursedDecimal ?? m.disbursed)} · in {money(m.collectedDecimal ?? m.collected)}
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
                    <td style={cell}>{money(p.outstandingDecimal ?? p.outstanding)}</td>
                    <td style={cell}>{money(p.par30Decimal ?? p.par30)}</td>
                    <td style={cell}>{money(p.par90Decimal ?? p.par90)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ fontSize: 13, color: '#5b6772' }}>
              Portfolio {money(analytics.totals.outstandingDecimal ?? analytics.totals.outstanding)} · PAR30 {money(analytics.totals.par30Decimal ?? analytics.totals.par30)} · PAR90{' '}
              {money(analytics.totals.par90Decimal ?? analytics.totals.par90)}
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
