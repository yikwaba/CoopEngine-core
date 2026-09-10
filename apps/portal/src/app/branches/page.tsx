'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch, clearSession, readToken } from '../../lib/api';
import Nav from '../components/Nav';

interface Branch {
  id: string;
  name: string;
  code: string | null;
  isHeadquarters: boolean;
  memberCount: number;
}

export default function BranchesPage() {
  const router = useRouter();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const token = readToken();
    if (!token) {
      router.replace('/login');
      return;
    }
    try {
      setBranches(await apiFetch<Branch[]>('/branches', token));
      setError(null);
    } catch (e) {
      if (String(e).includes('401')) {
        clearSession();
        router.replace('/login');
        return;
      }
      setError(e instanceof Error ? e.message : 'Could not load branches');
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    const token = readToken();
    if (!token || !name.trim()) return;
    setBusy(true);
    try {
      await apiFetch('/branches', token, {
        method: 'POST',
        body: JSON.stringify({ name, code: code || undefined }),
      });
      setName('');
      setCode('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  }

  async function makeHq(id: string) {
    const token = readToken();
    if (!token) return;
    setBusy(true);
    try {
      await apiFetch(`/branches/${id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ isHeadquarters: true }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  }

  const cell: React.CSSProperties = { padding: '6px 10px', borderBottom: '1px solid #e6e9ee', fontSize: 14 };

  return (
    <main style={{ maxWidth: 900, margin: '0 auto', padding: 20 }}>
      <h1 style={{ marginBottom: 4 }}>Branches</h1>
      <p style={{ color: '#5b6772', marginTop: 0 }}>
        Organize the cooperative into branches and see where members belong.
      </p>
      <Nav />

      {error && <p style={{ background: '#fdecea', color: '#8a1c1c', padding: 10, borderRadius: 6 }}>{error}</p>}

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: '#5b6772', fontSize: 13 }}>
            <th style={cell}>Name</th>
            <th style={cell}>Code</th>
            <th style={cell}>Members</th>
            <th style={cell}>Headquarters</th>
            <th style={cell} />
          </tr>
        </thead>
        <tbody>
          {branches.map((b) => (
            <tr key={b.id}>
              <td style={cell}>{b.name}</td>
              <td style={cell}>{b.code ?? '—'}</td>
              <td style={cell}>{b.memberCount}</td>
              <td style={cell}>{b.isHeadquarters ? 'Yes' : 'No'}</td>
              <td style={cell}>
                {!b.isHeadquarters && (
                  <button disabled={busy} onClick={() => void makeHq(b.id)}>
                    Make headquarters
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <input
          placeholder="Branch name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ padding: '8px 10px', border: '1px solid #cfd6de', borderRadius: 6 }}
        />
        <input
          placeholder="Code (optional)"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          style={{ padding: '8px 10px', border: '1px solid #cfd6de', borderRadius: 6, width: 140 }}
        />
        <button disabled={busy || !name.trim()} onClick={() => void create()}>
          Add branch
        </button>
      </div>

      <p style={{ marginTop: 22 }}>
        <Link href="/">← Dashboard</Link>
      </p>
    </main>
  );
}
