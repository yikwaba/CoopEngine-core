'use client';

import { useEffect } from 'react';

/** Registers the offline shell service worker (production builds only). */
export default function RegisterServiceWorker() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    if (process.env.NODE_ENV !== 'production') return;
    const timer = window.setTimeout(() => {
      void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, []);
  return null;
}
