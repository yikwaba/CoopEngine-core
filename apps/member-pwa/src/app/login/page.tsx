'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  apiFetch,
  storeMemberSession,
} from '../../lib/api';

interface OtpRequestResult {
  sent: boolean;
  devCode?: string;
  provider: string;
}

interface OtpVerifyResult {
  accessToken: string;
  member: { id: string; memberNo: number; firstName: string; lastName: string; email: string | null };
}

export default function MemberLoginPage() {
  const router = useRouter();
  const [organizationSlug, setOrganizationSlug] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [devCodeHint, setDevCodeHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function requestCode(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<OtpRequestResult>('/auth/member/request-otp', undefined, {
        method: 'POST',
        body: JSON.stringify({ organizationSlug: organizationSlug.trim(), email }),
      });
      if (!result.sent) {
        setError(
          'No active member found with that email in this cooperative. Check the details or contact your cooperative.',
        );
        return;
      }
      // Dev provider shows the code for local testing; production sends SMS/WhatsApp.
      setDevCodeHint(result.provider === 'dev' ? (result.devCode ?? null) : null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send code');
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<OtpVerifyResult>('/auth/member/verify-otp', undefined, {
        method: 'POST',
        body: JSON.stringify({
          organizationSlug: organizationSlug.trim(),
          email,
          code: code.trim(),
        }),
      });
      storeMemberSession(result.accessToken, result.member);
      router.push('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20 }}>
      <div className="card" style={{ width: 400 }}>
        <h1 style={{ margin: '0 0 4px' }}>My Cooperative</h1>
        <p style={{ margin: '0 0 18px', color: '#5b6772' }}>
          Sign in with the code sent to your phone or email
        </p>

        {error && (
          <p style={{ background: '#fdecea', color: '#b42318', borderRadius: 10, padding: '10px 12px', fontSize: 14 }}>
            {error}
          </p>
        )}
        {devCodeHint && (
          <p style={{ background: '#ecfdf3', color: '#067647', borderRadius: 10, padding: '10px 12px', fontSize: 14 }}>
            Dev code: <strong>{devCodeHint}</strong>
          </p>
        )}

        <div style={{ display: 'grid', gap: 12 }}>
          <label style={{ fontSize: 14, fontWeight: 600 }}>
            Cooperative
            <input
              className="field"
              style={{ marginTop: 6 }}
              value={organizationSlug}
              onChange={(e) => setOrganizationSlug(e.target.value)}
              placeholder="my-cooperative"
            />
          </label>
          <label style={{ fontSize: 14, fontWeight: 600 }}>
            Email
            <input
              className="field"
              style={{ marginTop: 6 }}
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </label>
          <button className="btn" disabled={busy} onClick={requestCode}>
            {busy ? 'Sending…' : 'Send me a code'}
          </button>

          <label style={{ fontSize: 14, fontWeight: 600 }}>
            6-digit code
            <input
              className="field"
              style={{ marginTop: 6 }}
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
            />
          </label>
          <button className="btn" disabled={busy || code.length !== 6} onClick={verifyCode}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </div>
    </main>
  );
}
