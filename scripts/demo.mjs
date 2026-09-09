#!/usr/bin/env node
/**
 * Co-opEngine end-to-end demo (FR walkthrough).
 *
 * Drives a REAL API (default http://localhost:3999/api/v1) through the full
 * product loop:
 *   onboard cooperative -> 5 members (2 approved) -> payroll contribution ->
 *   savings deposit -> share purchase -> loan apply/approve/disburse ->
 *   repayment -> reconciliation -> reports -> member OTP self-service view
 *
 * Usage:
 *   node scripts/demo.mjs                 # local API + seeded SaaS admin
 *   API_BASE=… node scripts/demo.mjs      # custom endpoint
 *
 * Requires: API running with migrations + seed applied (db:seed), and the
 * default dev SaaS admin (admin@coopengine.dev / AdminDev123!, see
 * packages/db/scripts/seed.mjs).
 */
const BASE = (process.env.API_BASE ?? 'http://localhost:3999/api/v1').replace(/\/$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@coopengine.dev';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'AdminDev123!';

const j = (r) => r.json();
const step = (msg) => console.log(`\n▶ ${msg}`);
const ok = (label, v) => console.log(`  ✓ ${label}: ${v}`);

async function api(path, { token, body, method = 'GET' } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = Array.isArray(data?.message)
      ? data.message.join('; ')
      : data?.message ?? res.status;
    throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(msg)}`);
  }
  return data;
}

const naira = (n) =>
  `₦${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

async function main() {
  const suffix = process.env.DEMO_SUFFIX ?? Date.now().toString(36).slice(-6);
  const slug = `demo-${suffix}`;
  const adminEmail = `demo-${suffix}@coopengine.test`;
  const adminPassword = 'CoopPass123!';

  console.log('Co-opEngine end-to-end demo');
  console.log('─────────────────────────────');
  console.log(`API: ${BASE}\n`);

  step('1. SaaS admin signs in');
  const saas = await api('/auth/login', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  ok('saas admin token', `${saas.tokens.accessToken.slice(0, 18)}…`);

  step('2. Onboard a cooperative (org + chart of accounts + OPEN period + admin)');
  const org = await api('/organizations', {
    method: 'POST',
    token: saas.tokens.accessToken,
    body: {
      name: `Demo Cooperative ${suffix}`,
      slug,
      adminEmail,
      adminPassword,
    },
  });
  ok('org', `${org.name} (${org.slug})`);
  const staff = await api('/auth/login', {
    method: 'POST',
    body: { email: adminEmail, password: adminPassword },
  });
  const staffTok = staff.tokens.accessToken;
  ok('coop admin login', `${adminEmail}`);

  step('3. Register 5 members (Ada, Grace, Linus, Chiamaka, Tunde) and approve');
  const people = [
    ['Ada', 'Lovelace'],
    ['Grace', 'Hopper'],
    ['Linus', 'Torvalds'],
    ['Chiamaka', 'Okafor'],
    ['Tunde', 'Bakare'],
  ];
  const members = [];
  for (const [first, last] of people) {
    const m = await api('/members', {
      method: 'POST',
      token: staffTok,
      body: {
        firstName: first,
        lastName: last,
        email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
      },
    });
    await api(`/members/${m.id}/approve`, { method: 'POST', token: staffTok });
    members.push(m);
    ok(`member ${m.memberNo}`, `${first} ${last} ACTIVE`);
  }
  const [ada, grace, linus, chiamaka, tunde] = members;

  step('4. Payroll contribution (2 members, one balanced batch journal)');
  const payrollCsv = [
    'memberNo,amount',
    `${ada.memberNo},20000`,
    `${grace.memberNo},15000`,
  ].join('\n');
  const preview = await api('/payroll/import/preview', {
    method: 'POST',
    token: staffTok,
    body: { filename: 'demo-deductions.csv', csv: payrollCsv },
  });
  const commit = await api('/payroll/import/commit', {
    method: 'POST',
    token: staffTok,
    body: { batchId: preview.batchId },
  });
  ok('payroll committed', `${commit.committed} members, ${naira(commit.totalAmount)}`);

  step('5. Linus deposits savings + buys share capital');
  const lAcc = await api(`/savings/member/${linus.id}/account`, {
    method: 'POST',
    token: staffTok,
    body: {},
  });
  await api(`/savings/accounts/${lAcc.id}/deposits`, {
    method: 'POST',
    token: staffTok,
    body: { amount: 30000 },
  });
  await api(`/shares/member/${linus.id}/purchases`, {
    method: 'POST',
    token: staffTok,
    body: { amount: 10000 },
  });
  ok('linus savings', naira(30000));
  ok('linus shares', naira(10000));

  step('6. Ada applies for a cash loan (₦40,000 over 3 months @ 15% flat)');
  const products = await api('/loans/products', { token: staffTok });
  const cashLoan = products.find((p) => p.code === 'CASH-LOAN');
  const loan = await api('/loans', {
    method: 'POST',
    token: staffTok,
    body: {
      memberId: ada.id,
      productId: cashLoan.id,
      principal: 40000,
      termMonths: 3,
      guarantorIds: [linus.id, chiamaka.id, tunde.id],
    },
  });
  await api(`/loans/${loan.id}/approve`, { method: 'POST', token: staffTok, body: {} });
  await api(`/loans/${loan.id}/disburse`, { method: 'POST', token: staffTok, body: {} });
  ok('loan disbursed', `${naira(40000)} outstanding`);
  const schedule = await api(`/loans/${loan.id}/schedule`, { token: staffTok });
  const firstInstallment =
    schedule.find((r) => r.status === 'PENDING' || r.status === 'PARTIAL') ?? schedule[0];
  ok('schedule', `${schedule.length} installments · first due ${firstInstallment?.dueDate} ${naira(firstInstallment?.principalDue + firstInstallment?.interestDue)}`);

  step('7. Ada repays the first installment (interest + principal split)');
  const dueTotal = Number(firstInstallment.principalDue) + Number(firstInstallment.interestDue);
  const repayment = await api(`/loans/${loan.id}/repayments`, {
    method: 'POST',
    token: staffTok,
    body: { amount: dueTotal },
  });
  ok('repaid', `${naira(dueTotal)} · outstanding now ${naira(repayment.loan.outstandingPrincipal)}`);

  step('8. Reconciliation: every savings account matches the ledger');
  const reconcile = await api('/reports/savings-reconciliation', { token: staffTok });
  ok('reconciliation', `${reconcile.matched}/${reconcile.checked} matched, ${reconcile.mismatches.length} mismatches`);

  step('9. Reports: savings book, loan aging, contribution schedule, trial balance');
  const savingsBook = await api('/reports/savings-book', { token: staffTok });
  const aging = await api('/reports/loans-aging', { token: staffTok });
  const trial = await api('/ledger/trial-balance', { token: staffTok });
  const scheduleReport = await api('/reports/contribution-schedule?months=3', { token: staffTok });
  ok('savings book', `${savingsBook.totalMembers} members · ${naira(savingsBook.totalBalance)}`);
  ok(
    'loan aging',
    (aging.buckets ?? []).map((b) => `${b.bucket}: ${b.count}`).join(', ') || 'no active loans',
  );
  ok('contribution schedule', `₦${scheduleReport.totalContributed} in ${scheduleReport.periodFrom}..${scheduleReport.periodTo}`);
  ok('trial balance net', `${naira(trial.net)} (must be 0)`);

  step('10. Member self-service: Ada requests an OTP and views her dashboard');
  const otp = await api('/auth/member/request-otp', {
    method: 'POST',
    body: { organizationSlug: slug, email: 'ada.lovelace@example.com' },
  });
  if (!otp.devCode) throw new Error('Member OTP did not return a dev code (is the member ACTIVE?)');
  const verify = await api('/auth/member/verify-otp', {
    method: 'POST',
    body: {
      organizationSlug: slug,
      email: 'ada.lovelace@example.com',
      code: otp.devCode,
    },
  });
  const dash = await api('/member/dashboard', { token: verify.accessToken });
  ok('member dashboard', `Ada — savings ${naira(dash.savingsTotal)}, loans ${naira(dash.loansOutstandingTotal)}, next due ${dash.nextDue ? `${naira(dash.nextDue.amount)} on ${dash.nextDue.dueDate}` : 'none'}`);

  console.log('\n─────────────────────────────');
  console.log('DEMO COMPLETE ✔');
  console.log('─────────────────────────────');
  console.log(`coop slug        : ${slug}`);
  console.log(`staff login      : ${adminEmail} / ${adminPassword}`);
  console.log(`trial balance    : net ${naira(trial.net)} (balanced books)`);
  console.log(`open docs        : ${BASE.replace('/api/v1', '')}/docs`);
}

main().catch((err) => {
  console.error('\nDEMO FAILED:', err.message);
  process.exit(1);
});
