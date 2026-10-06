import type { Metadata } from 'next';
import './globals.css';
import FinancialRecovery from '../components/financial-recovery';
import RegisterServiceWorker from './register-sw';

export const metadata: Metadata = {
  title: 'Co-opEngine Member',
  description: 'My cooperative account',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <RegisterServiceWorker />{children}<FinancialRecovery /></body>
    </html>
  );
}
