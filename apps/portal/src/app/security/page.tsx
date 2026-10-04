'use client';

import { useCallback, useEffect, useState } from 'react';
import { EnrollmentPanel, RecoveryCodesPanel } from '../../components/mfa-panels';
import { apiFetch, clearSession, readToken, storeSession, LoginOutcome } from '../../lib/api';

interface Me {
  user: { id: string; email: string; mfaEnabled: boolean };
  organizationId: string | null;
  organizationSlug: string | null;
  permissions: string[];
}

/**
 * Two-step verification for the signed-in account.
 *
 * The API could always do this; the portal had no way to reach it, which meant the platform's own
 * owner account could only ever be protected by a password. Enrolment shows the secret for manual
 * entry rather than a QR image, so nothing is fetched from a third party to set it up.
 */
export default function SecurityPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [otpauthUrl, setOtpauthUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<Me>('/auth/me', readToken() ?? undefined);
      setMe(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your account');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function startSetup(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch<{ secret: string; otpauthUrl: string; mfaToken: string }>(
        '/auth/mfa/setup',
        readToken() ?? undefined,
        { method: 'POST', body: JSON.stringify({}) },
      );
      setMfaToken(res.mfaToken);
      setSecret(res.secret);
      setOtpauthUrl(res.otpauthUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start setup');
    } finally {
      setBusy(false);
    }
  }

  async function confirmSetup(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const outcome = await apiFetch<LoginOutcome>('/auth/mfa/enroll', undefined, {
        method: 'POST',
        body: JSON.stringify({ mfaToken, code, organizationSlug: me?.organizationSlug ?? undefined }),
      });
      if (!outcome.tokens) throw new Error('Finish setup from sign-in with your cooperative short name.');
      storeSession(outcome.tokens, me?.user.email ?? ''); setCodes(outcome.recoveryCodes ?? []); setMfaToken(null);
      setSecret(null);
      setOtpauthUrl(null);
      setCode('');
      setNotice('Two-step verification is on. You will be asked for a code at every sign-in.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code was not accepted');
    } finally {
      setBusy(false);
    }
  }

  async function disable(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch('/auth/mfa/disable', readToken() ?? undefined, {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      setCode('');
      clearSession(); window.location.href = '/login';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code was not accepted');
    } finally {
      setBusy(false);
    }
  }

  async function regenerateCodes() {
    setBusy(true); setError(null);
    try {
      const result = await apiFetch<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes', undefined, { method: 'POST', body: JSON.stringify({ password, code }) });
      setCodes(result.recoveryCodes); setPassword(''); setCode('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not generate recovery codes'); } finally { setBusy(false); }
  }

  if (!me && !error) return <p className="muted">Loading…</p>;
  if (error && !me) {
    return (
      <p className="error">
        {error}{' '}
        <button
          className="link"
          onClick={() => {
            clearSession();
            window.location.href = '/login';
          }}
        >
          Sign in again
        </button>
      </p>
    );
  }

  const on = me?.user.mfaEnabled === true;


  return (
    <div className="stack">
      <h1>Security</h1>
      <p className="muted">
        Signed in as <strong>{me?.user.email}</strong>
        {me?.organizationId ? '' : ' (platform administration)'}
      </p>

      <section className="card">
        <h2>
          Two-step verification{' '}
          {on ? <span className="pill ok">On</span> : <span className="pill warn">Off</span>}
        </h2>
        <p className="muted">
          With this on, signing in needs your password <em>and</em> a six-digit code from your
          authenticator app. Production privileged accounts must keep this enabled; local recovery
          accounts follow their cooperative's security policy.
        </p>

        {notice && <p className="notice">{notice}</p>}
        {error && <p className="error">{error}</p>}

        {!on && !secret && (
          <button disabled={busy} onClick={() => void startSetup()}>
            {busy ? 'Working…' : 'Set up two-step verification'}
          </button>
        )}

        {!on && secret && <EnrollmentPanel enrollment={{ secret, otpauthUrl: otpauthUrl ?? '' }} code={code} setCode={setCode} busy={busy} confirm={confirmSetup} />}
        {codes && <RecoveryCodesPanel codes={codes} done={() => setCodes(null)} />}


        {on && (
          <div className="stack">
            <h3>Recovery codes</h3>
            <p>Generate a new set with your password and an authenticator code. This replaces all older recovery codes.</p>
            <label>Password<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
            <button disabled={busy || !password || code.length !== 6} onClick={() => void regenerateCodes()}>Generate recovery codes</button>
            <label>
              Authenticator code (required to generate codes or turn verification off), enter a current code
              <input
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="123456"
              />
            </label>
            <button
              className="danger"
              disabled={busy || code.length !== 6}
              onClick={() => void disable()}
            >
              {busy ? 'Checking…' : 'Turn off two-step verification'}
            </button>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Why this is here</h2>
        <p className="muted">
          Cooperatives can require two-step verification in Security policies. Production privileged
          roles cannot opt out. If you lose your authenticator, sign in with your password and a
          recovery code to enroll a replacement; recovery does not bypass verification.
        </p>
      </section>
    </div>
  );
}
