'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/members', label: 'Members' },
  { href: '/loans', label: 'Loans' },
  { href: '/products', label: 'Products' },
  { href: '/analytics', label: 'Analytics' },
  { href: '/notifications', label: 'Notifications' },
  { href: '/collections', label: 'Collections' },
  { href: '/audit', label: 'Audit' },
  { href: '/interest', label: 'Interest' },
  { href: '/users', label: 'Users' },
];

export default function Nav() {
  const pathname = usePathname();
  return (
    <nav style={{ display: 'flex', gap: 6, marginTop: 14, flexWrap: 'wrap' }}>
      {LINKS.map((l) => {
        const active = pathname === l.href || (l.href !== '/' && pathname.startsWith(l.href));
        return (
          <Link
            key={l.href}
            href={l.href}
            style={{
              padding: '6px 12px',
              borderRadius: 8,
              textDecoration: 'none',
              fontSize: 14,
              fontWeight: 600,
              background: active ? '#0a6c2e' : '#eef1f5',
              color: active ? '#fff' : '#17202a',
            }}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
