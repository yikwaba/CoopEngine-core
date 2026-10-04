'use client';
import { useEffect, useRef, useState } from 'react';
import { STEP_UP_EVENT, type StepUpRequest } from '../lib/api';
/** Native modal supplies focus containment, escape/cancel and focus restoration. */
export default function StepUpPrompt() {
  const dialog = useRef<HTMLDialogElement>(null);
  const active = useRef<StepUpRequest | null>(null);
  const [request, setRequest] = useState<StepUpRequest | null>(null);
  const [code, setCode] = useState('');
  function finish(value: string | null) {
    const pending = active.current; active.current = null;
    dialog.current?.close(); setCode(''); setRequest(null); pending?.resolve(value);
  }
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<StepUpRequest>).detail;
      // Concurrent submissions cannot share one code or silently queue mutations.
      if (active.current) { detail.resolve(null); return; }
      active.current = detail; setCode(''); setRequest(detail);
    };
    window.addEventListener(STEP_UP_EVENT, listener);
    return () => { window.removeEventListener(STEP_UP_EVENT, listener); active.current?.resolve(null); active.current = null; };
  }, []);
  useEffect(() => { if (request) dialog.current?.showModal(); }, [request]);
  return <dialog ref={dialog} aria-labelledby="step-up-title" onCancel={event => {event.preventDefault(); finish(null);}} style={{maxWidth:420,width:'calc(100% - 40px)',padding:24,border:'1px solid #cfd6de',borderRadius:12}}>
    <form className="stack" onSubmit={event => {event.preventDefault(); if (/^\d{6}$/.test(code)) finish(code);}}>
      <h2 id="step-up-title">Verify this action</h2>
      <p>{request?.message}</p>
      <p>Use a fresh code. If you just used a code to sign in or verify another action, wait for the next code.</p>
      <label>Verification code<input autoFocus className="field" autoComplete="one-time-code" inputMode="numeric" maxLength={6} required value={code} onChange={event => setCode(event.target.value.replace(/\D/g,''))} /></label>
      <button className="btn" type="submit" disabled={code.length!==6}>Verify and continue</button>
      <button type="button" onClick={() => finish(null)}>Cancel</button>
    </form>
  </dialog>;
}
