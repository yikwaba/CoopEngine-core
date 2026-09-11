#!/usr/bin/env node
/**
 * Co-opEngine showcase tenant.
 *
 * Builds one realistic Nigerian cooperative ("Sunrise Cooperative Society") with
 * everything an officer would meet on day one: staff logins for each role, 24
 * members, opening balances, loans at four different ages (including arrears), a
 * day of counter activity, a withdrawal waiting for a second officer, savings
 * goals, standing contributions and custom message wording.
 *
 * Idempotent by reset: `scripts/seed-showcase.sh` drops the tenant first, so the
 * logins it prints stay the same every time.
 */
const BASE = (process.env.API_BASE ?? 'http://localhost:3999/api/v1').replace(/\/$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@coopengine.dev';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'AdminDev123!';

const ORG = {
  name: 'Sunrise Cooperative Society',
  slug: process.env.SHOWCASE_SLUG ?? 'sunrise',
  adminEmail: 'manager@sunrise.coop',
  adminPassword: process.env.SHOWCASE_PASSWORD ?? 'Sunrise#2026',
};

const STAFF = [
  { email: 'treasurer@sunrise.coop', roleCodes: ['TREASURER'] },
  { email: 'loans@sunrise.coop', roleCodes: ['LOAN_OFFICER'] },
  { email: 'auditor@sunrise.coop', roleCodes: ['AUDITOR'] },
];

const MEMBERS = [
  ['Ada', 'Okafor', 'FEMALE', '1988-04-12', 'Trader'],
  ['Musa', 'Ibrahim', 'MALE', '1991-11-02', 'Civil servant'],
  ['Ngozi', 'Eze', 'FEMALE', '1985-07-23', 'Tailor'],
  ['Yusuf', 'Bello', 'MALE', '1979-02-17', 'Farmer'],
  ['Blessing', 'Adeyemi', 'FEMALE', '1993-09-30', 'Teacher'],
  ['Chinedu', 'Okonkwo', 'MALE', '1987-06-05', 'Driver'],
  ['Halima', 'Sani', 'FEMALE', '1990-12-14', 'Caterer'],
  ['Emeka', 'Nwosu', 'MALE', '1982-03-08', 'Electrician'],
  ['Fatima', 'Yakubu', 'FEMALE', '1995-05-21', 'Hairdresser'],
  ['Tunde', 'Balogun', 'MALE', '1976-08-19', 'Welder'],
  ['Grace', 'Aliyu', 'FEMALE', '1989-01-27', 'Nurse'],
  ['Sani', 'Abubakar', 'MALE', '1984-10-11', 'Mechanic'],
  ['Ronke', 'Ogundipe', 'FEMALE', '1992-04-04', 'Shop owner'],
  ['Ibrahim', 'Danladi', 'MALE', '1980-09-09', 'Transporter'],
  ['Chiamaka', 'Umeh', 'FEMALE', '1996-02-29', 'Student'],
  ['Bello', 'Garba', 'MALE', '1978-11-16', 'Livestock'],
  ['Aisha', 'Mohammed', 'FEMALE', '1991-07-07', 'Fashion designer'],
  ['Peter', 'Aluko', 'MALE', '1986-12-01', 'Carpenter'],
  ['Funke', 'Akinyemi', 'FEMALE', '1994-03-13', 'Provision store'],
  ['Danladi', 'Ishaku', 'MALE', '1975-05-25', 'Poultry'],
  ['Rukayat', 'Salami', 'FEMALE', '1997-08-08', 'Photographer'],
  ['Godwin', 'Etim', 'MALE', '1983-01-19', 'Fisherman'],
  ['Zainab', 'Umar', 'FEMALE', '1988-06-22', 'Grinding mill'],
  ['Segun', 'Ojo', 'MALE', '1981-10-30', 'Bricklayer'],
];

const pad = (s, n) => String(s).padEnd(n);
const naira = (n) => `₦${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const results = [];

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
    const msg = Array.isArray(data?.message) ? data.message.join('; ') : data?.message ?? res.status;
    throw new Error(`${method} ${path} -> ${res.status}: ${msg}`);
  }
  return data;
}

async function step(label, fn) {
  try {
    const detail = await fn();
    results.push({ label, ok: true, detail: detail ?? '' });
    console.log(`  ✓ ${pad(label, 44)} ${detail ?? ''}`);
    return true;
  } catch (e) {
    results.push({ label, ok: false, detail: e.message });
    console.log(`  ✗ ${pad(label, 44)} ${e.message}`);
    return false;
  }
}

const memberEmail = (i) => `member${String(i + 1).padStart(2, '0')}@sunrise.coop`;

const RUN = Date.now().toString(36);

async function main() {
  console.log('Co-opEngine showcase tenant');
  console.log('───────────────────────────');
  console.log(`API: ${BASE}\n`);

  const saas = await api('/auth/login', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  const saasToken = saas.tokens.accessToken;

  await step('onboard the cooperative', async () => {
    const org = await api('/organizations', {
      token: saasToken,
      method: 'POST',
      body: ORG,
    });
    return `${org.name} (${org.slug})`;
  });

  const login = await api('/auth/login', {
    method: 'POST',
    body: { email: ORG.adminEmail, password: ORG.adminPassword, organizationSlug: ORG.slug },
  });
  const token = login.tokens.accessToken;
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  const orgId = claims.org ?? claims.organizationId;

  const staffCredentials = [];
  for (const s of STAFF) {
    await step(`staff login: ${s.email}`, async () => {
      // The invite DTO takes only email + roles; the API issues a temporary password.
      const created = await api('/users', {
        token,
        method: 'POST',
        body: { email: s.email, roleCodes: s.roleCodes },
      });
      staffCredentials.push({
        role: s.roleCodes[0],
        email: s.email,
        password: created.tempPassword ?? '(unchanged — already existed)',
      });
      return `created as ${s.roleCodes.join(', ')}`;
    });
  }

  // ---------------------------------------------------------------- members
  await step('import 24 members', async () => {
    const header =
      'firstName,lastName,email,phone,gender,dateOfBirth,joinedOn,address,occupation,branchCode';
    const rows = MEMBERS.map((m, i) =>
      [
        m[0],
        m[1],
        memberEmail(i),
        `0803${String(1000000 + i * 137).slice(0, 7)}`,
        m[2],
        m[3],
        '2026-01-15',
        `"${i + 1} Market Road, Kaduna"`,
        m[4],
        i % 3 === 0 ? 'KAD-HQ' : i % 3 === 1 ? 'KAD-BR1' : 'KAD-BR2',
      ].join(','),
    );
    const csv = `${header}\n${rows.join('\n')}\n`;
    const preview = await api('/members/import/preview', {
      token,
      method: 'POST',
      body: { filename: 'sunrise-members.csv', csv },
    });
    if (preview.totals.valid !== MEMBERS.length) {
      throw new Error(`preview accepted ${preview.totals.valid}/${MEMBERS.length}`);
    }
    const commit = await api('/members/import/commit', {
      token,
      method: 'POST',
      body: { batchId: preview.batchId },
    });
    return `${commit.committed} members committed`;
  });

  let memberList = [];
  await step('approve members', async () => {
    const list = await api('/members?limit=100', { token });
    memberList = list;
    let approved = 0;
    for (const m of list) {
      if (m.status === 'PENDING') {
        await api(`/members/${m.id}/approve`, { token, method: 'POST', body: {} });
        approved += 1;
      }
    }
    return `${approved} approved (${list.length} total)`;
  });

  // ------------------------------------------------- opening balances + loans
  await step('post opening balances (5 loans, incl. arrears)', async () => {
    const header =
      'memberEmail,savings,shares,loanOutstanding,loanTermMonths,loanRatePa,loanDaysLate,loanPaidCount,loanPrincipal,loanLastPaymentDate';
    const savings = [250000, 180000, 320000, 95000, 410000, 60000, 275000, 150000, 380000, 120000];
    const shares = [50000, 30000, 75000, 20000, 100000, 15000, 60000, 25000, 80000, 40000];
    const rows = [];
    for (let i = 0; i < MEMBERS.length; i += 1) {
      const loan = i < 5;
      const outstanding = [120000, 80000, 60000, 45000, 30000][i] ?? 0;
      const daysLate = [0, 5, 20, 45, 95][i] ?? 0;
      rows.push(
        loan
          ? [
              memberEmail(i),
              savings[i % savings.length].toFixed(2),
              shares[i % shares.length].toFixed(2),
              outstanding.toFixed(2),
              12,
              15,
              daysLate,
              2,
              (outstanding * 1.5).toFixed(2),
              '2026-08-15',
            ].join(',')
          : [memberEmail(i), savings[i % savings.length].toFixed(2), shares[i % shares.length].toFixed(2), '', 0, 0, '', '', '', ''].join(','),
      );
    }
    const csv = `${header}\n${rows.join('\n')}\n`;
    const preview = await api('/migrations/opening-balances/preview', {
      token,
      method: 'POST',
      body: { label: 'Sunrise opening balances', filename: 'sunrise-balances.csv', csv },
    });
    if (preview.totals.valid !== MEMBERS.length) {
      throw new Error(`only ${preview.totals.valid}/${MEMBERS.length} rows valid: ${JSON.stringify(preview.rows?.[0]?.errors ?? [])}`);
    }
    const posted = await api(`/migrations/opening-balances/${preview.batchId}/commit`, {
      token,
      method: 'POST',
      body: {},
    });
    return `posted: savings ${naira(posted.savings)}, shares ${naira(posted.shares)}, loans ${naira(posted.loans)}`;
  });

  // ------------------------------------------------------------- day's work
  await step("record today's counter deposits", async () => {
    let count = 0;
    for (let i = 5; i < 11 && i < memberList.length; i += 1) {
      const accts = await api(`/savings/member/${memberList[i].id}/accounts`, { token });
      const account = Array.isArray(accts) ? accts[0] : accts?.items?.[0];
      if (!account) continue;
      await api(`/savings/accounts/${account.id}/deposits`, {
        token,
        method: 'POST',
        body: {
          amount: 5000 + i * 2500,
          description: `October savings (${RUN})`,
          idempotencyKey: `showcase-dep-${Date.now()}-${i}`,
        },
      });
      count += 1;
    }
    return `${count} deposits posted`;
  });

  await step('record a loan repayment', async () => {
    const loans = await api('/loans?status=DISBURSED&limit=10', { token });
    const rows = Array.isArray(loans) ? loans : loans?.items ?? [];
    if (rows.length === 0) throw new Error('no disbursed loans found');
    const loan = rows[0];
    await api(`/loans/${loan.id}/repayments`, {
      token,
      method: 'POST',
      body: {
        amount: 10000,
        description: `Counter repayment (${RUN})`,
        idempotencyKey: `showcase-repay-${Date.now()}`,
      },
    });
    return `repayment recorded on loan ${loan.loan_no ?? loan.id.slice(0, 8)}`;
  });

  await step('set withdrawal limit and queue one for approval', async () => {
    await api('/savings/settings/withdrawal-approval', {
      token,
      method: 'PATCH',
      body: { threshold: 50000 },
    });
    const accts = await api(`/savings/member/${memberList[0].id}/accounts`, { token });
    const account = Array.isArray(accts) ? accts[0] : accts?.items?.[0];
    await api(`/savings/accounts/${account.id}/withdrawals`, {
      token,
      method: 'POST',
      body: { amount: 80000, description: 'School fees — pending second officer' },
    });
    return 'limit set at ₦50,000; ₦80,000 awaiting approval';
  });

  await step('savings goals and standing contributions', async () => {
    await api(`/savings/goals/${memberList[1].id}`, {
      token,
      method: 'POST',
      body: { name: 'School fees 2027', targetAmount: 300000, targetDate: '2027-09-01' },
    });
    await api(`/savings/goals/${memberList[2].id}`, {
      token,
      method: 'POST',
      body: { name: 'New sewing machine', targetAmount: 180000, targetDate: '2027-03-01' },
    });
    for (let i = 6; i < 9; i += 1) {
      await api(`/savings/standing-instructions/${memberList[i].id}`, {
        token,
        method: 'POST',
        body: { amount: 10000, frequency: 'MONTHLY', nextRunDate: '2026-10-01' },
      });
    }
    return '2 goals, 3 standing contributions';
  });

  await step('word the contribution reminder locally', async () => {
    await api('/notifications/templates/CONTRIBUTION_DUE', {
      token,
      method: 'PUT',
      body: {
        title: 'Your savings is due — {{organizationName}}',
        body:
          'Hello {{memberName}}, your {{frequency}} contribution of N{{amount}} is due on {{dueDate}}. ' +
          'Kindly pay at the cooperative office or into the collection account. Thank you.',
      },
    });
    return 'custom SMS wording saved';
  });

  // -------------------------------------------------------------- final state
  const balance = await api('/ledger/trial-balance', { token });
  await step('trial balance', async () => `net ${naira(balance.net)}`);

  console.log('\n───────────────────────────');
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} steps succeeded`);

  console.log('\nLogins for testing:');
  console.log(`  Staff portal : https://app.coopengine.com.ng`);
  console.log(`  Cooperative  : ${ORG.slug}`);
  console.log(`  Manager      : ${ORG.adminEmail} / ${ORG.adminPassword}`);
  if (staffCredentials.length > 0) {
    for (const c of staffCredentials) {
      console.log(`  ${pad(c.role, 13)}: ${c.email} / ${c.password}`);
    }
  }
  console.log(`  Member app   : https://member.coopengine.com.ng`);
  console.log(`  Member       : member01@sunrise.coop (one-time code shown on screen)`);
  console.log(`  API          : https://api.coopengine.com.ng/api/v1`);

  if (failed.length > 0) {
    console.log('\nSteps that need attention:');
    for (const f of failed) console.log(`  - ${f.label}: ${f.detail}`);
  }
  void orgId;
}

main().catch((e) => {
  console.error('showcase seeding failed:', e.message);
  process.exit(1);
});
