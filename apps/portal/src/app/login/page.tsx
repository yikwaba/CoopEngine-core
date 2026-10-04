'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Enrollment, EnrollmentPanel, RecoveryCodesPanel } from '../../components/mfa-panels';
import { apiFetch, LoginOutcome, storeSession } from '../../lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [organizationSlug, setOrganizationSlug] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
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
      setPassword('');
      if (outcome.requiresMfaEnrollment && outcome.enrollment) {
        setEnrollment(outcome.enrollment); setMfaToken(outcome.mfaToken ?? null); return;
      }
      if (outcome.requiresMfa) {
        setMfaToken(outcome.mfaToken ?? null);
        return;
      }
      if (!outcome.tokens) {
        throw new Error(
          'No access token returned. If you belong to more than one cooperative, choose your organization on the next screen (or provide its short name).',
        );
      }
      // The session arrives as an httpOnly cookie; the browser keeps no token for scripts to steal.
      storeSession(outcome.tokens, email);
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

  async function finishEnrollment(): Promise<void> {
    setBusy(true); setError(null);
    try {
      const outcome = await apiFetch<LoginOutcome>('/auth/mfa/enroll', undefined, { method: 'POST', body: JSON.stringify({ mfaToken, code: mfaCode, organizationSlug: organizationSlug.trim() || undefined }) });
      if (!outcome.tokens) throw new Error('Enter your cooperative short name to finish setup.');
      storeSession(outcome.tokens, email); setEnrollment(null); setMfaToken(null); setMfaCode(''); setRecoveryCodes(outcome.recoveryCodes ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : 'Setup failed'); } finally { setBusy(false); }
  }
  async function recover(): Promise<void> {
    setBusy(true); setError(null);
    try {
      const outcome = await apiFetch<LoginOutcome>('/auth/mfa/recover', undefined, { method: 'POST', body: JSON.stringify({ mfaToken, recoveryCode }) });
      if (!outcome.enrollment || !outcome.mfaToken) throw new Error('Recovery could not start enrollment.');
      setEnrollment(outcome.enrollment); setMfaToken(outcome.mfaToken); setRecoveryCode(''); setRecovering(false); setMfaCode('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Recovery failed'); } finally { setBusy(false); }
  }

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20 }}>
      <div className="card" style={{ width: 420, maxWidth: '100%' }}>
        <h1 style={{ margin: '0 0 4px' }}>Co-opEngine</h1>
        <p style={{ margin: '0 0 18px', color: '#5b6772' }}>
          Cooperative operations portal
        </p>

        {error && (
          <p style={{ background: '#fdecea', color: '#b42318', borderRadius: 8, padding: '10px 12px', fontSize: 14 }}>
            {error}
          </p>
        )}

        {(mfaToken || enrollment) && <label>Cooperative short name (if needed)<input className="field" value={organizationSlug} onChange={e => setOrganizationSlug(e.target.value)} /></label>}
        {recoveryCodes ? <RecoveryCodesPanel codes={recoveryCodes} done={() => { setRecoveryCodes(null); router.push('/'); }} /> : enrollment ?
          <EnrollmentPanel enrollment={enrollment} code={mfaCode} setCode={setMfaCode} busy={busy} confirm={finishEnrollment} /> : mfaToken ? (
          <div style={{ display: 'grid', gap: 12 }}>
            {recovering ? <form className="stack" onSubmit={e => { e.preventDefault(); void recover(); }}>
              <label>Recovery code<input className="field" autoComplete="off" value={recoveryCode} onChange={e => setRecoveryCode(e.target.value.trim())} required /></label>
              <button className="btn" disabled={busy} type="submit">Recover authenticator</button>
            </form> : <><label style={{ fontSize: 14, fontWeight: 600 }}>
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
            </button></>}
            <button type="button" disabled={busy} onClick={() => { setRecovering(!recovering); setError(null); }}>{recovering ? 'Use authenticator code' : 'Use a recovery code'}</button>
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
            <Link href="/forgot-password">Forgot password?</Link>
          </form>
        )}
        {(mfaToken || enrollment) && <button type="button" disabled={busy} onClick={() => { setMfaToken(null); setEnrollment(null); setMfaCode(''); setRecoveryCode(''); setRecovering(false); setError(null); }}>Back to sign in</button>}
      </div>
    </main>
  );
}
