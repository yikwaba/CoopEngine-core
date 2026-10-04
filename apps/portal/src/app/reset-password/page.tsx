'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch, clearSession } from '../../lib/api';
import { resetTokenFromFragment } from '../../lib/password-reset';

export default function ResetPasswordPage() {
  const [token, setToken] = useState('');
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setToken(resetTokenFromFragment(window.location.hash));
    window.history.replaceState(null, '', window.location.pathname);
    setReady(true);
  }, []);
  async function submit() {
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    if (new TextEncoder().encode(password).length > 72) { setError('Password must be at most 72 UTF-8 bytes.'); return; }
    setBusy(true); setError('');
    try {
      await apiFetch<void>('/auth/password-reset/confirm', undefined,
        { method: 'POST', body: JSON.stringify({ token, password }) });
      clearSession(); setToken(''); setPassword(''); setConfirm(''); setDone(true);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to reset password.'); }
    finally { setBusy(false); }
  }
  return <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20 }}>
    <div className="card" style={{ width: '100%', maxWidth: 380 }}>
      <h1>Choose a new password</h1>
      {done ? <p role="status">Password changed. Sign in with your new password. Existing staff sessions have been revoked.</p> :
        !ready ? <p>Loading reset link…</p> : !token ? <p role="alert">This reset link is invalid. <Link href="/forgot-password">Request a new link</Link>.</p> :
        <form style={{ display: 'grid', gap: 12 }} onSubmit={e => { e.preventDefault(); void submit(); }}>
          <p>Use 12–72 characters. Your authenticator settings will stay in place.</p>
          {error && <p role="alert" style={{ color: '#b42318' }}>{error}</p>}
          <label>New password<input className="field" type="password" autoComplete="new-password" required minLength={12} maxLength={72}
            value={password} onChange={e => setPassword(e.target.value)} /></label>
          <label>Confirm password<input className="field" type="password" autoComplete="new-password" required minLength={12} maxLength={72}
            value={confirm} onChange={e => setConfirm(e.target.value)} /></label>
          <button className="btn" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
        </form>}
      <p><Link href="/login">Back to sign in</Link></p>
    </div>
  </main>;
}
