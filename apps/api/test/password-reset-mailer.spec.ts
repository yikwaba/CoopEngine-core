import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}), sendMail: vi.fn(async () => ({})), close: vi.fn(), createTransport: vi.fn() }));
vi.mock('node:fs/promises', () => ({ mkdir: mocks.mkdir, writeFile: mocks.writeFile }));
vi.mock('nodemailer', () => ({ createTransport: mocks.createTransport }));
import { PasswordResetMailer } from '../src/auth/password-reset-mailer';
const token = 'a'.repeat(64);
const keys = ['NODE_ENV', 'COOPENGINE_ENVIRONMENT', 'PORTAL_PUBLIC_URL', 'SMTP_HOST', 'SMTP_FROM', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'];
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
describe('password recovery delivery boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of keys) delete process.env[key];
    mocks.createTransport.mockReturnValue({ sendMail: mocks.sendMail, close: mocks.close });
  });
  afterEach(() => { for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; } });
  it('isolated staging captures synthetic mail in private files only', async () => {
    process.env.NODE_ENV = 'development'; process.env.COOPENGINE_ENVIRONMENT = 'isolated-staging';
    await new PasswordResetMailer().send('staff@recovery.invalid', token);
    expect(mocks.mkdir).toHaveBeenCalledWith('/tmp/coopengine-reset-mail', { recursive: true, mode: 0o700 });
    expect(mocks.writeFile).toHaveBeenCalledWith(expect.stringMatching(/\/tmp\/coopengine-reset-mail\/[a-f0-9]{64}\.json$/),
      JSON.stringify({ email: 'staff@recovery.invalid', link: `http://localhost:4310/reset-password#${token}` }), { mode: 0o600 });
    expect(mocks.createTransport).not.toHaveBeenCalled();
  });
  it('capture rejects a real recipient', async () => {
    process.env.NODE_ENV = 'development'; process.env.COOPENGINE_ENVIRONMENT = 'isolated-staging';
    await expect(new PasswordResetMailer().send('real@example.com', token)).rejects.toThrow('synthetic');
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
  it('production cannot opt into the staging capture', async () => {
    process.env.NODE_ENV = 'production'; process.env.COOPENGINE_ENVIRONMENT = 'isolated-staging';
    process.env.PORTAL_PUBLIC_URL = 'https://app.example.com';
    await expect(new PasswordResetMailer().send('staff@recovery.invalid', token)).rejects.toThrow('not configured');
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
  it('production requires a trusted HTTPS origin', async () => {
    process.env.NODE_ENV = 'production';
    for (const origin of ['http://app.example.com', 'https://user:pass@app.example.com', 'https://app.example.com/other', 'https://app.example.com?next=evil']) {
      process.env.PORTAL_PUBLIC_URL = origin;
      await expect(new PasswordResetMailer().send('staff@example.com', token)).rejects.toThrow('Invalid PORTAL_PUBLIC_URL');
    }
    expect(mocks.createTransport).not.toHaveBeenCalled();
  });
  it('SMTP uses TLS and fixed-origin fragment links', async () => {
    process.env.NODE_ENV = 'production'; process.env.PORTAL_PUBLIC_URL = 'https://app.example.com';
    process.env.SMTP_HOST = 'smtp.example.com'; process.env.SMTP_FROM = 'no-reply@example.com';
    await new PasswordResetMailer().send('staff@example.com', token);
    expect(mocks.createTransport).toHaveBeenCalledWith(expect.objectContaining({ requireTLS: true, disableFileAccess: true, disableUrlAccess: true }));
    expect(mocks.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'staff@example.com', text: expect.stringContaining(`https://app.example.com/reset-password#${token}`) }));
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
