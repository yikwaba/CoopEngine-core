'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch, downloadMemberPdf, readMemberToken, clearMemberSession } from '../../lib/api';

interface Statement {
  kind: string;
  label: string;
  description: string;
  downloadPath: string;
}

export default function StatementsPage() {
  const router = useRouter();
  const [docs, setDocs] = useState<Statement[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKind, setBusyKind] = useState<string | null>(null);

  const load = useCallback(async () => {
    const token = readMemberToken();
    if (!token) {
      router.replace('/login');
      return;
    }
    try {
      setDocs(await apiFetch<Statement[]>('/member/statements', token));
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not list your statements.';
      if (/unauthor|invalid token|expired|401/i.test(msg)) {
        clearMemberSession();
        router.replace('/login');
        return;
      }
      setError(msg);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function download(doc: Statement): Promise<void> {
    setBusyKind(doc.kind);
    setError(null);
    setMessage(null);
    try {
      const name = doc.kind === 'LOAN' ? 'loan-statement.pdf' : 'savings-statement.pdf';
      await downloadMemberPdf(doc.downloadPath, name);
      setMessage(`${doc.label} downloaded.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not prepare that document.');
    } finally {
      setBusyKind(null);
    }
  }

  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: 20 }}>
      <p style={{ fontSize: 14, marginTop: 0 }}>
        <Link href="/">← Back to dashboard</Link>
      </p>
      <h1 style={{ marginBottom: 4 }}>My statements</h1>
      <p style={{ color: '#5b6772', marginTop: 0, fontSize: 13 }}>
        Print or keep a copy of your records.
      </p>

      {message && <p style={{ background: '#e7f6ec', color: '#0a6c2e', padding: 10, borderRadius: 8 }}>{message}</p>}
      {error && <p style={{ background: '#fdecea', color: '#8a1c1c', padding: 10, borderRadius: 8 }}>{error}</p>}

      {docs && docs.length === 0 && (
        <p style={{ color: '#5b6772', fontSize: 14 }}>
          Nothing to print yet — once you have savings or a loan, your statements appear here.
        </p>
      )}

      {docs?.map((doc) => (
        <section
          key={doc.kind}
          style={{ border: '1px solid #e2e6eb', borderRadius: 12, padding: 16, marginTop: 12 }}
        >
          <div style={{ fontWeight: 600 }}>{doc.label}</div>
          <div style={{ color: '#5b6772', fontSize: 13, marginTop: 4 }}>{doc.description}</div>
          <button className="btn" style={{ marginTop: 12 }} disabled={busyKind !== null} onClick={() => download(doc)}>
            {busyKind === doc.kind ? 'Preparing…' : 'Download PDF'}
          </button>
        </section>
      ))}
    </main>
  );
}
