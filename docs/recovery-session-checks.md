# Recovery session checks — 3 October 2026

Baseline: `f757093c0070bb67cecc40e4844a03f30872d108`, local Windows Docker staging.

## Observed before this change

- PostgreSQL and API healthy; migration and fixture jobs exited 0.
- Synthetic two-tenant baseline passed, including member RLS and guessed-ID denial.
- Staff login and dashboard loaded; dashboard showed the expected three synthetic members.
- Opening Members redirected to login. Member record access was blocked.
- Source confirmed F05: seven request paths used the legacy bearer marker without credentials.

## Change and verification

The seven paths now share the cookie transport used by JSON API requests. Raw responses retain pagination headers and binary bodies. A 401 clears the session; other failed requests preserve it and show the page error. No database, financial rule, or production configuration changes.

Local regression checks cover cookie credentials, pagination, binary responses, 401, 403, 500, network failure, and all seven call sites. Portal typecheck and production build passed. These checks do not replace browser acceptance against the real staging API.

## Pending browser acceptance

1. Sign in to local staging with the synthetic staff account.
2. Open Members; expect three rows and no login redirect.
3. Search and open a member; confirm their record loads.
4. Refresh the record; confirm the session persists.
5. Visit Loans, Collections and Audit; expect normal empty/list states, not login redirects.
6. Exercise document and CSV downloads when synthetic data supports them.

F05 remains pending browser verification on the corrected build. Other recovery defects remain open.

## Browser evidence — 4 October 2026, Lagos

The corrected portal build `3b56ad683015c450cfb6974b7bc131b5251800b1` loaded the three-member list and Synthetic1 TenantA's record in the user's local browser. Member listing and record access passed. Other F05 download/list paths remain pending browser acceptance.

The member record displayed `₦NaN` for loan outstanding. API contract inspection found the page read `loansOutstanding` instead of `loansOutstandingTotal`; it also used stale savings `id`/`currentBalance` and loan `code` fields. The follow-up change uses the API's `accountId`, `balance`, `productCode`, and `loansOutstandingTotal` fields without substituting guessed values. A source contract regression check verifies the page's fields and render/action expressions against the actual backend interface. Eight regression checks, portal typecheck and production build passed locally. Corrected balance display and financial action acceptance remain pending; the account-ID correction does not establish that deposits/withdrawals are safe or complete.

## Member checks and Audit 400 — 4 October 2026, Lagos

The user confirmed the follow-up local portal displays loan outstanding 0, and reported CSV/PDF statement downloads working. These are user-observed local staging results, not production acceptance or verification of populated financial records.

Audit displayed Request failed (400) while preserving the session. The audit query DTO used number validators without explicit query-string transformation; the portal sends limit=25 and offset=0. Add explicit Number transformation plus integer/bounds validation (limit 1–500, offset >=0). Ten isolated real HTTP tests through Nest's production ValidationPipe configuration cover exact portal pagination, filters, omitted values and rejected invalid values; ReportsService persistence and guards are stubbed in these tests. Staging database audit acceptance remains pending after installing the corrected API.
