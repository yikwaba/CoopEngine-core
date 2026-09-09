'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch, clearSession, readToken, API_BASE } from '../../lib/api';

interface MemberRow {
  id: string;
  memberNo: number;
  firstName: string;
  lastName: string;
  email: string | null;
  status: string;
}

const PAGE = 10;

export default function MembersPage() {
  const router = useRouter();
  const [items, setItems] = useState<MemberRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const load = useCallback(
    async (q: string, off: number) => {
      const token = readToken();
      if (!token) {
        router.replace('/login');
        return;
      }
      try {
        const res = await fetch(
          `${API_BASE}/members?limit=${PAGE}&offset=${off}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
          { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
        );
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        const body = (await res.json()) as MemberRow[];
        setItems(body);
        setTotal(Number(res.headers.get('x-total-count') ?? body.length));
      } catch (err) {
        clearSession();
        setError(err instanceof Error ? err.message : 'Failed to load members');
        router.replace('/login');
      }
    },
    [router],
  );

  useEffect(() => {
    load('', 0).then(() => setReady(true));
  }, [load]);

  function search(e: React.FormEvent): void {
    e.preventDefault();
    setOffset(0);
    void load(query, 0);
  }

  const pages = Math.max(1, Math.ceil(total / PAGE));
  const page = Math.floor(offset / PAGE) + 1;

  return (
    <main style={{ maxWidth: 1000, margin: '0 auto', padding: 28 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ margin: 0 }}>Members</h1>
          <p style={{ margin: '4px 0 0', color: '#5b6772', fontSize: 14 }}>
            {ready ? `${total} member${total === 1 ? '' : 's'}` : '…'}
          </p>
        </div>
        <Link href="/" style={{ fontSize: 14 }}>
          ← Dashboard
        </Link>
      </div>

      <form onSubmit={search} style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
        <input
          className="field"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, email or member number…"
          style={{ maxWidth: 380 }}
        />
        <button className="btn" type="submit">
          Search
        </button>
      </form>

      {error && <p style={{ color: '#b42318' }}>{error}</p>}

      <div className="card">
        <table className="data">
          <thead>
            <tr>
              <th>No.</th>
              <th>Name</th>
              <th>Email</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {ready && items.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ color: '#5b6772' }}>
                  No members found.
                </td>
              </tr>
            ) : (
              items.map((m) => (
                <tr key={m.id}>
                  <td>{m.memberNo}</td>
                  <td>
                    {m.firstName} {m.lastName}
                  </td>
                  <td>{m.email ?? '—'}</td>
                  <td>{m.status}</td>
                  <td>
                    <Link href={`/members/${m.id}`} style={{ fontSize: 14 }}>
                      Open →
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 14, alignItems: 'center' }}>
        <button
          className="btn secondary"
          disabled={page <= 1}
          onClick={() => {
            const off = Math.max(0, offset - PAGE);
            setOffset(off);
            void load(query, off);
          }}
        >
          ← Prev
        </button>
        <span style={{ fontSize: 14, color: '#5b6772' }}>
          Page {page} of {pages}
        </span>
        <button
          className="btn secondary"
          disabled={page >= pages}
          onClick={() => {
            const off = offset + PAGE;
            setOffset(off);
            void load(query, off);
          }}
        >
          Next →
        </button>
      </div>
    </main>
  );
}
