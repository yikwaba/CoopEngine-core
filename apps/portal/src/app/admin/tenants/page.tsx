'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, readToken } from '../../../lib/api';

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  members: number;
  savingsBalance: string;
  activeLoans: number;
  loansOutstanding: string;
  staff: number;
  plan: { code: string; name: string } | null;
  subscriptionStatus: string | null;
  renewsAt: string | null;
}

interface Plan {
  id: string;
  code: string;
  name: string;
  priceAmount: string;
  currency: string;
  limits: Record<string, number | null>;
  features: Record<string, boolean>;
  cooperatives?: number;
}

interface Overview {
  cooperatives: { total: number; active: number; suspended: number; pending: number };
  members: number;
  savingsBalance: string;
  loansOutstanding: string;
  subscriptions: { active: number; trial: number; pastDue: number; unassigned: number };
  plans: number;
}

const money = (value: string | number) =>
  `N${Number(value ?? 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The platform operator's console: every cooperative, what it holds, and which plan it is on.
 *
 * It is deliberately part of the same portal rather than a separate application — the person
 * running the platform wants their own figures in the same place they see everything else.
 */
export default function AdminTenantsPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const token = readToken();
    if (!token) {
      setError('Sign in first.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const query = search ? `?q=${encodeURIComponent(search)}&limit=50` : '?limit=50';
      const [summary, list, catalogue] = await Promise.all([
        apiFetch<Overview>('/admin/overview', token),
        apiFetch<{ rows: TenantRow[]; total: number }>(`/admin/tenants${query}`, token),
        apiFetch<Plan[]>('/admin/plans', token),
      ]);
      setOverview(summary);
      setTenants(list.rows);
      setPlans(catalogue);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(
        /forbidden|403/i.test(message)
          ? 'This screen is for the platform operator. Sign in with the platform administrator account.'
          : message,
      );
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    void load();
  }, [load]);

  const assign = async (tenant: TenantRow, planCode: string) => {
    const token = readToken();
    if (!token) return;
    setBusy(tenant.id);
    setNotice(null);
    setError(null);
    try {
      await apiFetch(`/admin/tenants/${tenant.id}/subscription`, token, {
        method: 'POST',
        body: JSON.stringify({ planCode, status: 'ACTIVE' }),
      });
      setNotice(`${tenant.name} moved to the ${planCode} plan.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const setStatus = async (tenant: TenantRow, status: string) => {
    const token = readToken();
    if (!token) return;
    setBusy(tenant.id);
    setNotice(null);
    setError(null);
    try {
      await apiFetch(`/admin/tenants/${tenant.id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      setNotice(
        status === 'SUSPENDED'
          ? `${tenant.name} is suspended. Its staff can no longer sign in; no data was touched.`
          : `${tenant.name} is active again.`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="p-6 space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Cooperatives</h1>
        <p className="text-sm text-gray-600">
          Every cooperative on the platform, what it holds, and the plan it is on.
        </p>
      </header>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">{error}</div>
      )}
      {notice && (
        <div className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-800">
          {notice}
        </div>
      )}

      {overview && (
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded border p-3">
            <div className="text-xs uppercase text-gray-500">Cooperatives</div>
            <div className="text-xl font-semibold">{overview.cooperatives.total}</div>
            <div className="text-xs text-gray-500">
              {overview.cooperatives.active} active
              {overview.cooperatives.suspended > 0 ? ` · ${overview.cooperatives.suspended} suspended` : ''}
            </div>
          </div>
          <div className="rounded border p-3">
            <div className="text-xs uppercase text-gray-500">Members</div>
            <div className="text-xl font-semibold">{overview.members.toLocaleString()}</div>
          </div>
          <div className="rounded border p-3">
            <div className="text-xs uppercase text-gray-500">Savings held</div>
            <div className="text-xl font-semibold">{money(overview.savingsBalance)}</div>
          </div>
          <div className="rounded border p-3">
            <div className="text-xs uppercase text-gray-500">Loans outstanding</div>
            <div className="text-xl font-semibold">{money(overview.loansOutstanding)}</div>
          </div>
        </section>
      )}

      <section className="flex items-end gap-3">
        <label className="text-sm">
          <span className="block text-gray-600">Search</span>
          <input
            className="mt-1 rounded border px-3 py-2"
            placeholder="name or slug"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <button className="rounded border px-3 py-2 text-sm" onClick={() => void load()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <span className="text-sm text-gray-500">
          {overview ? `${overview.subscriptions.unassigned} cooperative(s) without a plan` : ''}
        </span>
      </section>

      <section className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-gray-600">
            <tr>
              <th className="p-2">Cooperative</th>
              <th className="p-2">Status</th>
              <th className="p-2">Members</th>
              <th className="p-2">Savings</th>
              <th className="p-2">Loans out</th>
              <th className="p-2">Staff</th>
              <th className="p-2">Plan</th>
              <th className="p-2">Move to</th>
              <th className="p-2">Access</th>
            </tr>
          </thead>
          <tbody>
            {tenants.map((tenant) => (
              <tr key={tenant.id} className="border-t">
                <td className="p-2">
                  <div className="font-medium">{tenant.name}</div>
                  <div className="text-xs text-gray-500">{tenant.slug}</div>
                </td>
                <td className="p-2">{tenant.status}</td>
                <td className="p-2">{tenant.members}</td>
                <td className="p-2">{money(tenant.savingsBalance)}</td>
                <td className="p-2">{money(tenant.loansOutstanding)}</td>
                <td className="p-2">{tenant.staff}</td>
                <td className="p-2">
                  {tenant.plan ? (
                    <span>
                      {tenant.plan.name}
                      <span className="block text-xs text-gray-500">{tenant.subscriptionStatus}</span>
                    </span>
                  ) : (
                    <span className="text-xs text-gray-500">no plan (unmetered)</span>
                  )}
                </td>
                <td className="p-2">
                  <select
                    className="rounded border px-2 py-1"
                    value={tenant.plan?.code ?? ''}
                    disabled={busy === tenant.id}
                    onChange={(event) => void assign(tenant, event.target.value)}
                  >
                    <option value="">choose…</option>
                    {plans.map((plan) => (
                      <option key={plan.id} value={plan.code}>
                        {plan.name} · {money(plan.priceAmount)}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="p-2">
                  <button
                    className="rounded border px-2 py-1 text-xs"
                    disabled={busy === tenant.id}
                    onClick={() => void setStatus(tenant, tenant.status === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED')}
                  >
                    {tenant.status === 'SUSPENDED' ? 'Re-activate' : 'Suspend'}
                  </button>
                </td>
              </tr>
            ))}
            {tenants.length === 0 && !loading && (
              <tr>
                <td className="p-3 text-gray-500" colSpan={9}>
                  No cooperatives match that search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}
