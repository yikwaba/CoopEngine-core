import { Injectable } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

@Injectable()
export class PasswordResetMailer {
  async send(email: string, token: string): Promise<void> {
    const staging = process.env.NODE_ENV !== 'production' && process.env.COOPENGINE_ENVIRONMENT === 'isolated-staging';
    const origin = new URL(process.env.PORTAL_PUBLIC_URL ?? (staging ? 'http://localhost:4310' : ''));
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' ||
        !(origin.protocol === 'https:' || (staging && origin.protocol === 'http:' && origin.hostname === 'localhost'))) {
      throw new Error('Invalid PORTAL_PUBLIC_URL');
    }
    // Fragment avoids putting the recovery secret in HTTP request/access logs.
    const link = `${origin.origin}/reset-password#${token}`;
    if (staging && !process.env.SMTP_HOST) {
      if (!email.endsWith('@recovery.invalid')) throw new Error('Staging capture requires a synthetic recipient');
      const directory = '/tmp/coopengine-reset-mail';
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const name = createHash('sha256').update(email).digest('hex');
      await writeFile(`${directory}/${name}.json`, JSON.stringify({ email, link }), { mode: 0o600 });
      return;
    }
    if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) throw new Error('Password recovery mail is not configured');
    const port = Number(process.env.SMTP_PORT ?? 587);
    const transport = createTransport({
      host: process.env.SMTP_HOST, port, secure: port === 465, requireTLS: port !== 465,
      auth: process.env.SMTP_USER && process.env.SMTP_PASS ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      connectionTimeout: 2000, greetingTimeout: 2000, socketTimeout: 2000,
      disableFileAccess: true, disableUrlAccess: true,
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        transport.sendMail({ from: process.env.SMTP_FROM, to: email, subject: 'Reset your Co-opEngine password',
          text: `Use this link to reset your password. It expires in 15 minutes and can be used once.\n\n${link}\n\nIf you did not request this, ignore this message. Your password has not changed.` }),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Recovery mail timed out')), 2500); }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      transport.close();
    }
  }
}
