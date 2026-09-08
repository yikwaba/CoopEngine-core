#!/usr/bin/env node
/**
 * RBAC seed — permission catalog, role templates and the dev SaaS admin.
 *
 * Role templates are org-agnostic rows (organization_id NULL); onboarding
 * assigns them via user_roles. Idempotent — safe to run repeatedly.
 *
 * Usage:
 *   DATABASE_URL=... SEED_ADMIN_EMAIL=... SEED_ADMIN_PASSWORD=... \
 *     node scripts/seed.mjs
 */
import pg from 'pg';
import bcrypt from 'bcryptjs';

const { Pool } = pg;

const url =
  process.env.DATABASE_URL ??
  'postgres://coopengine:coopengine@127.0.0.1:5432/coopengine';

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@coopengine.dev';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'AdminDev123!';

const PERMISSIONS = {
  saas: [
    ['saas.tenants.manage', 'Create/suspend cooperative workspaces'],
    ['saas.plans.manage', 'Manage subscription plans'],
    ['saas.billing.manage', 'Manage tenant billing'],
    ['saas.support.access', 'Audited time-limited support access'],
    ['saas.platform.health', 'Platform health and ops'],
  ],
  org: [
    ['members.create', 'Create member records'],
    ['members.edit', 'Edit member records'],
    ['members.approve', 'Approve membership'],
    ['members.import', 'Bulk import members'],
    ['members.export', 'Export member data'],
    ['members.lookup', 'Restricted member lookup'],
    ['savings.post', 'Post savings contributions'],
    ['savings.withdraw', 'Process withdrawals'],
    ['savings.reverse', 'Reverse savings transactions'],
    ['savings.export', 'Export savings records'],
    ['shares.post', 'Post share transactions'],
    ['loans.review', 'Review loan applications'],
    ['loans.approve', 'Approve loans within limits'],
    ['loans.disburse', 'Disburse loans'],
    ['loans.restructure', 'Restructure/payoff loans'],
    ['payments.reconcile', 'Reconcile payments'],
    ['journals.create', 'Create journal entries'],
    ['journals.approve', 'Approve journal entries'],
    ['journals.post', 'Post journal entries'],
    ['payroll.upload', 'Upload payroll batches'],
    ['payroll.approve', 'Approve payroll batches'],
    ['payroll.post', 'Post payroll batches'],
    ['reports.view', 'View reports'],
    ['reports.export', 'Export reports'],
    ['settings.manage', 'Manage tenant settings'],
    ['users.manage', 'Manage tenant users and roles'],
    ['audit.view', 'View audit logs'],
    ['documents.manage', 'Manage documents'],
    ['notifications.send', 'Send notifications'],
    ['collections.capture', 'Capture restricted collections'],
  ],
};

const ROLE_TEMPLATES = {
  SAAS_ADMIN: [
    'saas.tenants.manage',
    'saas.plans.manage',
    'saas.billing.manage',
    'saas.support.access',
    'saas.platform.health',
    'audit.view',
    'reports.view',
  ],
  COOP_ADMIN: [
    'users.manage',
    'settings.manage',
    'members.create',
    'members.edit',
    'members.approve',
    'members.import',
    'members.export',
    'reports.view',
    'reports.export',
    'documents.manage',
    'notifications.send',
    'audit.view',
    'journals.create',
    'journals.approve',
    'journals.post',
    'payments.reconcile',
    'savings.post',
    'savings.withdraw',
    'loans.review',
    'loans.approve',
    'loans.disburse',
    'loans.restructure',
  ],
  CHAIRMAN: ['reports.view', 'reports.export', 'loans.approve', 'members.approve'],
  SECRETARY: [
    'members.create',
    'members.edit',
    'members.approve',
    'documents.manage',
    'notifications.send',
    'reports.view',
  ],
  TREASURER: [
    'savings.post',
    'savings.withdraw',
    'payments.reconcile',
    'journals.create',
    'reports.view',
    'reports.export',
  ],
  ACCOUNTANT: [
    'journals.create',
    'journals.approve',
    'journals.post',
    'savings.export',
    'reports.view',
    'reports.export',
  ],
  LOAN_OFFICER: ['loans.review', 'reports.view'],
  CREDIT_COMMITTEE: ['loans.approve'],
  PAYROLL_OFFICER: ['payroll.upload', 'reports.view'],
  AUDITOR: ['reports.view', 'reports.export', 'audit.view'],
  MEMBER: [],
  FIELD_AGENT: ['members.lookup', 'collections.capture'],
};

const pool = new Pool({ connectionString: url });

async function main() {
  // 1. Permissions
  const permIdByCode = {};
  for (const [, list] of Object.entries(PERMISSIONS)) {
    for (const [code, description] of list) {
      await pool.query(
        `INSERT INTO permissions (code, description)
         VALUES ($1, $2)
         ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description`,
        [code, description],
      );
      const { rows } = await pool.query(
        `SELECT id FROM permissions WHERE code = $1`,
        [code],
      );
      permIdByCode[code] = rows[0].id;
    }
  }

  // 2. Role templates (org-agnostic)
  const roleIdByCode = {};
  for (const [code, perms] of Object.entries(ROLE_TEMPLATES)) {
    const { rows } = await pool.query(
      `SELECT id FROM roles WHERE code = $1 AND organization_id IS NULL`,
      [code],
    );
    let roleId = rows[0]?.id;
    if (!roleId) {
      const ins = await pool.query(
        `INSERT INTO roles (code, name, scope)
         VALUES ($1, $2, 'org')
         RETURNING id`,
        [code, code.replaceAll('_', ' ').toLowerCase()],
      );
      roleId = ins.rows[0].id;
    }
    roleIdByCode[code] = roleId;

    // role_permissions: full sync (delete + insert)
    await pool.query(`DELETE FROM role_permissions WHERE role_id = $1`, [
      roleId,
    ]);
    for (const permCode of perms) {
      const permId = permIdByCode[permCode];
      if (!permId) {
        throw new Error(`Permission not found for role ${code}: ${permCode}`);
      }
      await pool.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [roleId, permId],
      );
    }
  }

  // 3. SaaS admin template role (scope saas)
  const { rows: saasRows } = await pool.query(
    `SELECT id FROM roles WHERE code = 'SAAS_ADMIN' AND scope = 'saas' AND organization_id IS NULL`,
  );
  if (saasRows.length === 0) {
    const ins = await pool.query(
      `INSERT INTO roles (code, name, scope) VALUES ('SAAS_ADMIN', 'SaaS Admin', 'saas') RETURNING id`,
    );
    const saasRoleId = ins.rows[0].id;
    const saasPerms = [
      'saas.tenants.manage',
      'saas.plans.manage',
      'saas.billing.manage',
      'saas.support.access',
      'saas.platform.health',
      'audit.view',
      'reports.view',
    ];
    for (const permCode of saasPerms) {
      await pool.query(
        `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [saasRoleId, permIdByCode[permCode]],
      );
    }
    console.log('seeded saas role: SAAS_ADMIN');
  }

  // 4. Dev SaaS admin user
  const { rows: existing } = await pool.query(
    `SELECT id FROM users WHERE email = $1`,
    [ADMIN_EMAIL],
  );
  let adminUserId = existing[0]?.id;
  if (!adminUserId) {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    const ins = await pool.query(
      `INSERT INTO users (email, password_hash, status)
       VALUES ($1, $2, 'ACTIVE')
       RETURNING id`,
      [ADMIN_EMAIL, hash],
    );
    adminUserId = ins.rows[0].id;
    console.log(`seeded admin user: ${ADMIN_EMAIL}`);
  }
  const { rows: saasRole } = await pool.query(
    `SELECT id FROM roles WHERE code = 'SAAS_ADMIN' AND scope = 'saas'`,
  );
  if (saasRole.length > 0) {
    const { rows: hasRole } = await pool.query(
      `SELECT id FROM user_roles WHERE user_id = $1 AND role_id = $2 AND organization_id IS NULL`,
      [adminUserId, saasRole[0].id],
    );
    if (hasRole.length === 0) {
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
        [adminUserId, saasRole[0].id],
      );
      console.log('assigned SAAS_ADMIN to', ADMIN_EMAIL);
    }
  }

  const summary = await pool.query(
    `SELECT (SELECT count(*) FROM permissions)  AS permissions,
            (SELECT count(*) FROM roles)         AS roles,
            (SELECT count(*) FROM role_permissions) AS role_permissions,
            (SELECT count(*) FROM users)         AS users,
            (SELECT count(*) FROM user_roles)    AS user_roles`,
  );
  console.log('seed summary:', summary.rows[0]);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
