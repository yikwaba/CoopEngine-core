'use client';
import { useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '../../lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  async function submit() {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await apiFetch<{ message: string }>('/auth/password-reset/request', undefined,
        { method: 'POST', body: JSON.stringify({ email }) });
      setMessage(result.message);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to request recovery. Try again.'); }
    finally { setBusy(false); }
  }
  return <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20 }}>
    <div className="card" style={{ width: '100%', maxWidth: 380 }}>
      <h1>Reset your password</h1>
      <p>Enter your staff email to request a reset link. The link expires in 15 minutes.</p>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert" style={{ color: '#b42318' }}>{error}</p>}
      <form style={{ display: 'grid', gap: 12 }} onSubmit={e => { e.preventDefault(); void submit(); }}>
        <label>Email<input className="field" type="email" autoComplete="email" required maxLength={254}
          value={email} onChange={e => setEmail(e.target.value)} /></label>
        <button className="btn" type="submit" disabled={busy}>{busy ? 'Requesting…' : 'Send reset link'}</button>
      </form>
      <p><Link href="/login">Back to sign in</Link></p>
    </div>
  </main>;
}
