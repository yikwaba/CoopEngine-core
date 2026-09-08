import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Co-opEngine Member',
  description: 'My cooperative account',
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
