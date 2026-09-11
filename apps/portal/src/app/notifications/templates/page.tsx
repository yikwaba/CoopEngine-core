'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch, readToken } from '../../../lib/api';

interface Template {
  code: string;
  description: string;
  defaultChannel: string;
  variables: Record<string, string>;
  isCustomised: boolean;
  title: string;
  body: string;
  defaultTitle: string;
  defaultBody: string;
  updatedAt: string | null;
}

interface PreviewResult {
  title: string;
  body: string;
  smsParts: number;
  unresolved: string[];
}

export default function NotificationTemplatesPage() {
  const [items, setItems] = useState<Template[]>([]);
  const [selected, setSelected] = useState('');
  const [draft, setDraft] = useState({ title: '', body: '' });
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const token = readToken();
    if (!token) {
      setErr('Please sign in.');
      return;
    }
    try {
      const list = await apiFetch<Template[]>('/notifications/templates', token);
      setItems(list);
      setSelected((cur) => cur || list[0]?.code || '');
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load the message wording.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const current = items.find((t) => t.code === selected);

  useEffect(() => {
    if (current) {
      setDraft({ title: current.title, body: current.body });
      setPreview(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, current?.isCustomised, current?.updatedAt]);

  async function runPreview() {
    const token = readToken();
    if (!token || !selected) return;
    try {
      const result = await apiFetch<PreviewResult>(
        `/notifications/templates/${selected}/preview`,
        token,
        { method: 'POST', body: JSON.stringify(draft) },
      );
      setPreview(result);
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not render a preview.');
    }
  }

  async function save() {
    const token = readToken();
    if (!token || !selected) return;
    setBusy(true);
    setMsg('');
    setErr('');
    try {
      await apiFetch(`/notifications/templates/${selected}`, token, {
        method: 'PUT',
        body: JSON.stringify({ title: draft.title, body: draft.body }),
      });
      setMsg('Saved — members will receive this wording.');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    const token = readToken();
    if (!token || !selected) return;
    if (!window.confirm('Discard your wording and go back to the built-in message?')) return;
    try {
      await apiFetch(`/notifications/templates/${selected}`, token, { method: 'DELETE' });
      setMsg('Reset to the built-in wording.');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not reset.');
    }
  }

  return (
    <main style={{ maxWidth: 1000, margin: '0 auto', padding: 24 }}>
      <Link href="/">← Dashboard</Link>
      <h1 style={{ marginTop: 12 }}>Message wording</h1>
      <p style={{ color: '#555' }}>
        Choose how your cooperative words its SMS and email notifications. Anything in{' '}
        <code>{'{{braces}}'}</code> is filled in automatically.
      </p>
      {err && <p style={{ color: '#b91c1c' }}>{err}</p>}

      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 20, marginTop: 16 }}>
        <nav style={{ borderRight: '1px solid #eee', paddingRight: 12 }}>
          {items.map((t) => (
            <button
              key={t.code}
              onClick={() => setSelected(t.code)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '8px 10px',
                marginBottom: 4,
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
                background: t.code === selected ? '#eef2ff' : 'transparent',
                fontWeight: t.code === selected ? 600 : 400,
              }}
            >
              {t.code.replaceAll('_', ' ').toLowerCase()}
              {t.isCustomised && <span style={{ color: '#16a34a' }}> •</span>}
            </button>
          ))}
        </nav>

        <section>
          {current ? (
            <>
              <p style={{ color: '#666', marginTop: 0 }}>{current.description}</p>
              <label style={{ display: 'block', fontWeight: 600, marginTop: 12 }}>Title</label>
              <input
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                style={{ width: '100%', padding: 8, border: '1px solid #ddd', borderRadius: 6 }}
              />
              <label style={{ display: 'block', fontWeight: 600, marginTop: 12 }}>Message</label>
              <textarea
                value={draft.body}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                rows={5}
                style={{ width: '100%', padding: 8, border: '1px solid #ddd', borderRadius: 6 }}
              />
              <p style={{ color: '#666', fontSize: 13 }}>
                Available: {Object.keys(current.variables).map((v) => `{{${v}}}`).join('  ')}
              </p>

              <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                <button
                  onClick={save}
                  disabled={busy}
                  style={{ padding: '8px 14px', borderRadius: 6, border: 'none', background: '#1d4ed8', color: '#fff', cursor: 'pointer' }}
                >
                  {busy ? 'Saving…' : 'Save wording'}
                </button>
                <button
                  onClick={runPreview}
                  style={{ padding: '8px 14px', borderRadius: 6, border: '1px solid #ddd', background: '#fff', cursor: 'pointer' }}
                >
                  Preview
                </button>
                <button
                  onClick={reset}
                  style={{ padding: '8px 14px', borderRadius: 6, border: '1px solid #fca5a5', background: '#fff', color: '#b91c1c', cursor: 'pointer' }}
                >
                  Reset to built-in
                </button>
              </div>
              {msg && <p style={{ marginTop: 10, color: '#166534' }}>{msg}</p>}

              {preview && (
                <div style={{ marginTop: 16, border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, background: '#fafafa' }}>
                  <strong>{preview.title}</strong>
                  <p style={{ marginBottom: 4 }}>{preview.body}</p>
                  <span style={{ fontSize: 12, color: '#666' }}>
                    {preview.smsParts} SMS part{preview.smsParts > 1 ? 's' : ''} (160 characters each)
                  </span>
                  {preview.unresolved.length > 0 && (
                    <p style={{ fontSize: 12, color: '#b45309' }}>
                      No value supplied for: {preview.unresolved.map((u) => `{{${u}}}`).join(', ')}
                    </p>
                  )}
                </div>
              )}
            </>
          ) : (
            <p>Loading…</p>
          )}
        </section>
      </div>
    </main>
  );
}
