'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, LoginOutcome, storeSession, TOKEN_KEY } from '../../lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [organizationSlug, setOrganizationSlug] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function doLogin(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const outcome = await apiFetch<LoginOutcome>('/auth/login', undefined, {
        method: 'POST',
        body: JSON.stringify({
          email,
          password,
          organizationSlug: organizationSlug.trim() || undefined,
        }),
      });
      if (outcome.requiresMfa) {
        setMfaToken(outcome.mfaToken ?? null);
        return;
      }
      if (!outcome.tokens) {
        throw new Error(
          'No access token returned. If you belong to more than one cooperative, choose your organization on the next screen (or provide its short name).',
        );
      }
      storeSession(outcome.tokens, email);
      localStorage.setItem(TOKEN_KEY, outcome.tokens.accessToken);
      router.push('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  async function submitMfa(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const outcome = await apiFetch<LoginOutcome>('/auth/mfa/login-verify', undefined, {
        method: 'POST',
        body: JSON.stringify({
          mfaToken,
          code: mfaCode,
          organizationSlug: organizationSlug.trim() || undefined,
        }),
      });
      if (!outcome.tokens) throw new Error('MFA accepted but no token returned');
      storeSession(outcome.tokens, email);
      router.push('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'MFA verification failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20 }}>
      <div className="card" style={{ width: 380 }}>
        <h1 style={{ margin: '0 0 4px' }}>Co-opEngine</h1>
        <p style={{ margin: '0 0 18px', color: '#5b6772' }}>
          Cooperative operations portal
        </p>

        {error && (
          <p style={{ background: '#fdecea', color: '#b42318', borderRadius: 8, padding: '10px 12px', fontSize: 14 }}>
            {error}
          </p>
        )}

        {mfaToken ? (
          <div style={{ display: 'grid', gap: 12 }}>
            <label style={{ fontSize: 14, fontWeight: 600 }}>
              Authenticator code
              <input
                className="field"
                style={{ marginTop: 6 }}
                inputMode="numeric"
                value={mfaCode}
                maxLength={6}
                onChange={(e) => setMfaCode(e.target.value)}
                placeholder="123456"
              />
            </label>
            <button className="btn" disabled={busy} onClick={submitMfa}>
              {busy ? 'Verifying…' : 'Verify code'}
            </button>
          </div>
        ) : (
          <form
            style={{ display: 'grid', gap: 12 }}
            onSubmit={(e) => {
              e.preventDefault();
              void doLogin();
            }}
          >
            <label style={{ fontSize: 14, fontWeight: 600 }}>
              Email
              <input
                className="field"
                style={{ marginTop: 6 }}
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@cooperative.ng"
              />
            </label>
            <label style={{ fontSize: 14, fontWeight: 600 }}>
              Password
              <input
                className="field"
                style={{ marginTop: 6 }}
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </label>
            <label style={{ fontSize: 14, fontWeight: 600 }}>
              Cooperative <span style={{ fontWeight: 400, color: '#5b6772' }}>(its short name, e.g. sunrise)</span>
              <input
                className="field"
                style={{ marginTop: 6 }}
                value={organizationSlug}
                onChange={(e) => setOrganizationSlug(e.target.value)}
                placeholder="sunrise"
              />
            </label>
            <button className="btn" disabled={busy} type="submit">
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
