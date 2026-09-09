'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch, clearSession, readToken } from '../../lib/api';

interface OrgUser {
  id: string;
  email: string;
  status: string;
  roleCodes: string[];
}

const ROLE_OPTIONS = [
  'COOP_ADMIN',
  'CHAIRMAN',
  'SECRETARY',
  'TREASURER',
  'ACCOUNTANT',
  'LOAN_OFFICER',
  'CREDIT_COMMITTEE',
  'PAYROLL_OFFICER',
  'AUDITOR',
];

export default function UsersPage() {
  const router = useRouter();
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [email, setEmail] = useState('');
  const [roles, setRoles] = useState<string[]>(['TREASURER']);
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
      const rows = await apiFetch<OrgUser[]>('/users', token);
      setUsers(rows);
      setError(null);
    } catch (err) {
      clearSession();
      setError(err instanceof Error ? err.message : 'Failed to load users');
      router.replace('/login');
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function invite(): Promise<void> {
    const token = readToken();
    if (!token || !email) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await apiFetch<OrgUser & { tempPassword: string }>('/users', token, {
        method: 'POST',
        body: JSON.stringify({ email, roleCodes: roles }),
      });
      setNotice(
        `Invited ${created.email} (${created.roleCodes.join(', ')}). One-time password: ${created.tempPassword}`,
      );
      setEmail('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invite failed');
    } finally {
      setBusy(false);
    }
  }

  async function replaceRoles(target: OrgUser, newRoles: string[]): Promise<void> {
    const token = readToken();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/users/roles', token, {
        method: 'PATCH',
        body: JSON.stringify({ email: target.email, roleCodes: newRoles }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Role change failed');
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(target: OrgUser): Promise<void> {
    const token = readToken();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const next = target.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
      await apiFetch('/users/status', token, {
        method: 'PATCH',
        body: JSON.stringify({ email: target.email, status: next }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Status change failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 1000, margin: '0 auto', padding: 28 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0 }}>Users</h1>
        <Link href="/" style={{ fontSize: 14 }}>
          ← Dashboard
        </Link>
      </div>

      {notice && (
        <p style={{ background: '#ecfdf3', color: '#067647', borderRadius: 8, padding: '10px 12px', marginTop: 14 }}>
          {notice}
        </p>
      )}
      {error && (
        <p style={{ background: '#fdecea', color: '#b42318', borderRadius: 8, padding: '10px 12px', marginTop: 14 }}>
          {error}
        </p>
      )}

      <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ margin: '0 0 10px', fontSize: 16 }}>Invite staff</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            className="field"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="staff@cooperative.ng"
            style={{ maxWidth: 280 }}
          />
          <select
            className="field"
            style={{ maxWidth: 200 }}
            value={roles.join(',')}
            onChange={(e) => setRoles([e.target.value])}
          >
            {ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button className="btn" disabled={busy || !email} onClick={() => void invite()}>
            Invite
          </button>
        </div>
      </section>

      <div className="card" style={{ marginTop: 14 }}>
        <table className="data">
          <thead>
            <tr>
              <th>Email</th>
              <th>Roles</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td>
                  <select
                    className="field"
                    style={{ padding: '4px 8px', fontSize: 13, maxWidth: 180 }}
                    value={u.roleCodes[0] ?? ''}
                    disabled={busy}
                    onChange={(e) => void replaceRoles(u, [e.target.value])}
                  >
                    {u.roleCodes.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                    {ROLE_OPTIONS.filter((r) => !u.roleCodes.includes(r)).map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </td>
                <td>{u.status}</td>
                <td>
                  <button className="btn secondary" style={{ padding: '5px 10px' }} disabled={busy} onClick={() => void toggleStatus(u)}>
                    {u.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
