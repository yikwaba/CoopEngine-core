import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PdfService } from './pdf.service';
vi.mock('@coopengine/db', () => ({ withTenant: async (pool: unknown, _org: unknown, fn: (c: unknown) => unknown) => fn(pool) }));
const member = { member_no: 1, first_name: 'Statement', last_name: 'Synthetic', status: 'ACTIVE' };
const account = { id: 'a', account_no: '1', current_balance: '90071992547409.99' };
function service(rows: unknown[][]) {
  let i = 0;
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: rows[i++] ?? [] }));
  const texts: string[] = [];
  const pdf = new PdfService({ query } as unknown as Pool);
  const original = (pdf as any).doc.bind(pdf);
  vi.spyOn(pdf as any, 'doc').mockImplementation(() => {
    const doc = original(), text = doc.text;
    doc.text = function (value: string, ...args: unknown[]) { texts.push(String(value)); return text.call(this, value, ...args); };
    return doc;
  });
  return { pdf, texts, query };
}
describe('statement semantics', () => {
  it('closes at the final displayed transaction, not the current projection', async () => {
    const s = service([[member], [account], [{ type: 'DEPOSIT', signed_amount: '0.01', running_balance: '90071992547409.92', created_at: new Date('2026-01-10') }], [{ name: 'SYNTHETIC' }]]);
    const rendered = await s.pdf.memberStatement('org', 'member', '2026-01-01', '2026-01-31');
    if (process.env.COOPENGINE_PDF_QA_DIR) { await mkdir(process.env.COOPENGINE_PDF_QA_DIR, {recursive:true}); await writeFile(join(process.env.COOPENGINE_PDF_QA_DIR,'historical-statement.pdf'), rendered.buffer); }
    expect(s.texts).toContain('Opening balance: NGN 90,071,992,547,409.91');
    expect(s.texts).toContain('Closing balance: NGN 90,071,992,547,409.92');
    expect(s.texts.join(' ')).not.toContain('90,071,992,547,409.99');
  });
  it('does not invent a historical balance when no transactions exist', async () => {
    const s = service([[member], [account], [], [], [{ name: 'SYNTHETIC' }]]);
    await s.pdf.memberStatement('org', 'member', undefined, '2025-12-31');
    expect(s.texts).toContain('Closing balance: Unavailable (no transaction history)');
    expect(s.texts).toContain('Current projected balance: NGN 90,071,992,547,409.99');
  });
  it.each([true, false])('recovers an empty period from its historical anchor (before_end=%s)', async before_end => {
    const s = service([[member], [account], [], [{ before_end, running_balance: '90071992547409.92', signed_amount: '0.01' }], [{ name: 'SYNTHETIC' }]]);
    await s.pdf.memberStatement('org', 'member', '2026-02-01', '2026-02-28');
    const value = before_end ? '92' : '91';
    expect(s.texts).toContain(`Opening balance: NGN 90,071,992,547,409.${value}`);
    expect(s.texts).toContain(`Closing balance: NGN 90,071,992,547,409.${value}`);
    expect(s.query.mock.calls[3]?.[1]).toEqual(['a', '2026-02-28']);
  });
  it.each([
    ['2099-01-01', '0.01', '0.00', 'PARTIAL'],
    ['2000-01-01', '0.01', '0.00', 'OVERDUE'],
    ['2099-01-01', '1.00', '0.01', 'PAID'],
    ['2099-01-01', '1.01', '0.00', 'PARTIAL'],
    ['2099-01-01', '0.00', '0.00', 'PENDING'],
  ])('labels instalment due %s paid %s + %s as %s', async (date, principal, interest, status) => {
    const s = service([[{ ...member, principal: '1.00', outstanding_principal: '1.00', interest_rate_pa: '12', term_months: 1, interest_method: 'FLAT', status: 'DISBURSED' }], [{ seq: 1, due_date: new Date(date), principal_due: '1.00', interest_due: '0.01', paid_principal: principal, paid_interest: interest }], [{ name: 'SYNTHETIC' }]]);
    const rendered = await s.pdf.loanStatement('org', 'loan');
    if (process.env.COOPENGINE_PDF_QA_DIR && principal === '0.01' && date === '2099-01-01') await writeFile(join(process.env.COOPENGINE_PDF_QA_DIR,'partial-loan.pdf'), rendered.buffer);
    expect(s.texts).toContain(status);
    if (status !== 'PAID') expect(s.texts).not.toContain('PAID');
  });
});
