import type { Metadata } from 'next';
import './globals.css';
import FinancialRecovery from '../components/financial-recovery';
import StepUpPrompt from '../components/step-up-prompt';

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
      <body>{children}<FinancialRecovery /><StepUpPrompt /></body>
    </html>
  );
}
