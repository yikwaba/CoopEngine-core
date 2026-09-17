'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, clearSession, readToken } from '../../lib/api';

interface Me {
  user: { id: string; email: string; mfaEnabled: boolean };
  organizationId: string | null;
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
      const res = await apiFetch<{ secret: string; otpauthUrl: string }>(
        '/auth/mfa/setup',
        readToken() ?? undefined,
        { method: 'POST', body: JSON.stringify({}) },
      );
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
      await apiFetch('/auth/mfa/verify-setup', readToken() ?? undefined, {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
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
      setNotice('Two-step verification is off.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code was not accepted');
    } finally {
      setBusy(false);
    }
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
  const grouped = secret ? secret.replace(/(.{4})/g, '$1 ').trim() : '';

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
          authenticator app. It is the single most useful thing you can do to protect an account
          that can move money or administer the platform.
        </p>

        {notice && <p className="notice">{notice}</p>}
        {error && <p className="error">{error}</p>}

        {!on && !secret && (
          <button disabled={busy} onClick={() => void startSetup()}>
            {busy ? 'Working…' : 'Set up two-step verification'}
          </button>
        )}

        {!on && secret && (
          <div className="stack">
            <p>
              Open your authenticator app (Google Authenticator, Authy, 1Password, Microsoft
              Authenticator), choose <strong>Add account → Enter a setup key</strong>, and use:
            </p>
            <p className="code">{grouped}</p>
            <p className="muted">
              Account name: <code>{me?.user.email}</code> · Type: time-based (TOTP). If your app can
              take a link instead: <code className="wrap">{otpauthUrl}</code>
            </p>
            <label>
              Then enter the six-digit code it shows
              <input
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="123456"
              />
            </label>
            <div className="row">
              <button disabled={busy || code.length !== 6} onClick={() => void confirmSetup()}>
                {busy ? 'Checking…' : 'Turn on'}
              </button>
              <button
                className="link"
                onClick={() => {
                  setSecret(null);
                  setCode('');
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {on && (
          <div className="stack">
            <label>
              To turn it off, enter a current code
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
          A cooperative can already require two-step verification from its own staff (Security
          policies in its settings), and the platform owner account holds administration over every
          cooperative. Until now that could only be switched on through the API.
        </p>
      </section>
    </div>
  );
}
