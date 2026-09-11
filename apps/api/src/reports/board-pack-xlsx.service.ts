import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import ExcelJS from 'exceljs';
import { withTenant } from '@coopengine/db';
import { DB_POOL } from '../database/database.module';

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/**
 * Board pack as a workbook, for committees that want the numbers in Excel.
 * One sheet per view, so a treasurer can pivot or chart without retyping.
 */
@Injectable()
export class BoardPackXlsxService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async build(organizationId: string, periodCode: string): Promise<Buffer> {
    const data = await withTenant(this.pool, organizationId, async (c) => {
      const org = await c.query(`SELECT name FROM organizations WHERE id = $1`, [organizationId]);
      const membership = await c.query(
        `SELECT status, count(*)::int AS members FROM members GROUP BY status ORDER BY status`,
      );
      const savings = await c.query(
        `SELECT count(*)::int AS accounts, coalesce(sum(current_balance), 0) AS total
           FROM member_savings_accounts WHERE status = 'ACTIVE'`,
      );
      const shares = await c.query(
        `SELECT count(*)::int AS accounts, coalesce(sum(current_balance), 0) AS total
           FROM member_share_accounts`,
      );
      const loans = await c.query(
        `SELECT status, count(*)::int AS count, coalesce(sum(outstanding_principal), 0) AS outstanding
           FROM loans GROUP BY status ORDER BY status`,
      );
      const arrears = await c.query(
        `SELECT
           CASE
             WHEN now()::date - lr.due_date BETWEEN 1 AND 30 THEN '1-30'
             WHEN now()::date - lr.due_date BETWEEN 31 AND 60 THEN '31-60'
             WHEN now()::date - lr.due_date BETWEEN 61 AND 90 THEN '61-90'
             ELSE '90+'
           END AS bucket,
           count(*)::int AS instalments,
           coalesce(sum(lr.principal_due - coalesce(lr.paid_principal, 0)), 0) AS amount
         FROM loan_repayments lr
         WHERE lr.due_date < now()::date
           AND (lr.principal_due - coalesce(lr.paid_principal, 0)) > 0
         GROUP BY 1 ORDER BY 1`,
      );
      const dividends = await c.query(
        `SELECT period_label, coalesce(sum(distributable_amount), 0) AS total
           FROM dividend_runs WHERE period_label = $1 GROUP BY period_label`,
        [periodCode],
      ).catch(() => ({ rows: [] as Record<string, unknown>[] }));
      const trial = await c.query(
        `SELECT a.code, a.name, a.type,
                coalesce(sum(jl.debit), 0) AS debit,
                coalesce(sum(jl.credit), 0) AS credit
           FROM chart_of_accounts a
           LEFT JOIN journal_lines jl ON jl.account_id = a.id
           LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED'
          GROUP BY a.code, a.name, a.type
          ORDER BY a.code`,
      );
      return { org, membership, savings, shares, loans, arrears, dividends, trial };
    });

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Co-opEngine';
    wb.created = new Date();

    const orgName = (data.org.rows[0]?.name as string) ?? 'Cooperative';

    // ---- Summary -------------------------------------------------------------
    const summary = wb.addWorksheet('Summary');
    summary.columns = [
      { header: 'Item', key: 'item', width: 34 },
      { header: 'Value', key: 'value', width: 20 },
    ];
    const totalSavings = n(data.savings.rows[0]?.total);
    const totalShares = n(data.shares.rows[0]?.total);
    const totalLoans = data.loans.rows
      .filter((r) => ['DISBURSED', 'APPROVED', 'DEFAULTED'].includes(String(r.status)))
      .reduce((acc, r) => acc + n(r.outstanding), 0);
    const arrearsTotal = data.arrears.rows.reduce((acc, r) => acc + n(r.amount), 0);
    summary.addRows([
      { item: 'Cooperative', value: orgName },
      { item: 'Period', value: periodCode },
      { item: 'Generated', value: new Date().toISOString().slice(0, 19).replace('T', ' ') },
      { item: 'Members (all statuses)', value: data.membership.rows.reduce((a, r) => a + n(r.members), 0) },
      { item: 'Savings accounts', value: n(data.savings.rows[0]?.accounts) },
      { item: 'Total savings', value: totalSavings },
      { item: 'Total share capital', value: totalShares },
      { item: 'Loan book outstanding', value: totalLoans },
      { item: 'Arrears (overdue instalments)', value: arrearsTotal },
    ]);

    // ---- Membership ----------------------------------------------------------
    const mem = wb.addWorksheet('Membership');
    mem.columns = [
      { header: 'Status', key: 'status', width: 16 },
      { header: 'Members', key: 'members', width: 12 },
    ];
    data.membership.rows.forEach((r) => mem.addRow({ status: r.status, members: n(r.members) }));

    // ---- Savings -------------------------------------------------------------
    const sav = wb.addWorksheet('Savings');
    sav.columns = [
      { header: 'Metric', key: 'metric', width: 24 },
      { header: 'Amount', key: 'amount', width: 18 },
    ];
    sav.addRows([
      { metric: 'Active accounts', amount: n(data.savings.rows[0]?.accounts) },
      { metric: 'Total savings', amount: totalSavings },
    ]);

    // ---- Shares --------------------------------------------------------------
    const shr = wb.addWorksheet('Shares');
    shr.columns = [
      { header: 'Metric', key: 'metric', width: 24 },
      { header: 'Amount', key: 'amount', width: 18 },
    ];
    shr.addRows([
      { metric: 'Share accounts', amount: n(data.shares.rows[0]?.accounts) },
      { metric: 'Total share capital', amount: totalShares },
    ]);

    // ---- Loans ---------------------------------------------------------------
    const loanSheet = wb.addWorksheet('Loans');
    loanSheet.columns = [
      { header: 'Status', key: 'status', width: 16 },
      { header: 'Loans', key: 'count', width: 10 },
      { header: 'Outstanding', key: 'outstanding', width: 18 },
    ];
    data.loans.rows.forEach((r) =>
      loanSheet.addRow({ status: r.status, count: n(r.count), outstanding: n(r.outstanding) }),
    );

    // ---- Arrears -------------------------------------------------------------
    const arr = wb.addWorksheet('Arrears');
    arr.columns = [
      { header: 'Ageing bucket (days)', key: 'bucket', width: 22 },
      { header: 'Instalments', key: 'instalments', width: 14 },
      { header: 'Amount overdue', key: 'amount', width: 18 },
    ];
    data.arrears.rows.forEach((r) =>
      arr.addRow({ bucket: r.bucket, instalments: n(r.instalments), amount: n(r.amount) }),
    );

    // ---- Dividends -----------------------------------------------------------
    const div = wb.addWorksheet('Dividends');
    div.columns = [
      { header: 'Period', key: 'period', width: 18 },
      { header: 'Distributable', key: 'total', width: 18 },
    ];
    data.dividends.rows.forEach((r) => div.addRow({ period: r.period_label, total: n(r.total) }));

    // ---- Trial balance -------------------------------------------------------
    const tb = wb.addWorksheet('Trial Balance');
    tb.columns = [
      { header: 'Code', key: 'code', width: 10 },
      { header: 'Account', key: 'name', width: 34 },
      { header: 'Type', key: 'type', width: 14 },
      { header: 'Debit', key: 'debit', width: 18 },
      { header: 'Credit', key: 'credit', width: 18 },
      { header: 'Net', key: 'net', width: 18 },
    ];
    let dr = 0;
    let cr = 0;
    data.trial.rows.forEach((r) => {
      const debit = n(r.debit);
      const credit = n(r.credit);
      dr += debit;
      cr += credit;
      tb.addRow({
        code: r.code,
        name: r.name,
        type: r.type,
        debit,
        credit,
        net: Number((debit - credit).toFixed(2)),
      });
    });
    tb.addRow({});
    tb.addRow({ name: 'TOTAL', debit: Number(dr.toFixed(2)), credit: Number(cr.toFixed(2)), net: Number((dr - cr).toFixed(2)) });

    // Money columns read as figures, not text.
    for (const sheet of [summary, sav, shr, loanSheet, arr, div, tb]) {
      sheet.eachRow((row: ExcelJS.Row, idx: number) => {
        if (idx === 1) row.font = { bold: true };
      });
    }

    return Buffer.from(await wb.xlsx.writeBuffer());
  }
}
