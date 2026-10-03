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
