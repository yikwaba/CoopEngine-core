import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Co-opEngine',
  referrer: 'no-referrer',
  description: 'Cooperative operations portal',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
