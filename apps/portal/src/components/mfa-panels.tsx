'use client';

export interface Enrollment { secret: string; otpauthUrl: string; }
export function EnrollmentPanel({ enrollment, code, setCode, busy, confirm }: {
  enrollment: Enrollment; code: string; setCode: (value: string) => void; busy: boolean; confirm: () => Promise<void>;
}) {
  return <form className="stack" onSubmit={e => { e.preventDefault(); void confirm(); }}>
    <h2>Set up two-step verification</h2>
    <p>Add a time-based account in your authenticator app using this setup key:</p>
    <p className="code" data-testid="mfa-setup-secret" style={{ overflowWrap: 'anywhere' }}>{enrollment.secret}</p>
    <p className="muted">Keep this key private. Enter the six-digit code from your app to finish setup.</p>
    <label>Authenticator code<input className="field" inputMode="numeric" autoComplete="one-time-code" value={code} maxLength={6} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} required /></label>
    <button className="btn" type="submit" disabled={busy || code.length !== 6}>{busy ? 'Verifying…' : 'Finish setup'}</button>
  </form>;
}
export function RecoveryCodesPanel({ codes, done }: { codes: string[]; done: () => void }) {
  function download() {
    const url = URL.createObjectURL(new Blob(['CoopEngine recovery codes — keep private. Each code works once with your password.\n\n' + codes.join('\n')], { type: 'text/plain' }));
    const a = document.createElement('a'); a.href = url; a.download = 'coopengine-recovery-codes.txt'; a.click(); URL.revokeObjectURL(url);
  }
  return <section className="stack" aria-label="Recovery codes">
    <h2>Save your recovery codes</h2>
    <p>Keep these in a safe place separate from your authenticator. Each code works once with your password. They will not be shown again.</p>
    <textarea aria-label="Recovery codes" readOnly rows={10} value={codes.join('\n')} style={{ width: '100%', fontFamily: 'monospace' }} />
    <button type="button" onClick={download}>Download recovery codes</button>
    <button className="btn" type="button" onClick={done}>I have saved my codes</button>
  </section>;
}
