# Product permission recovery — F01

The products controller declared `products.view` and `products.manage` permissions but only installed the JWT authentication guard. A valid signed-in user could reach product methods without the declared permissions. Install `PermissionsGuard` after `JwtAuthGuard` at controller scope so every product route enforces its existing permission declaration.

## Expected behavior

- No session: HTTP 401.
- Authenticated without the required permission: HTTP 403 before the service runs.
- `products.view`: savings and loan lists only.
- `products.manage`: savings/loan creation, updates and status changes. Listing still requires `products.view` as declared by the existing policy.
- An authorized manager's writes remain scoped to the authenticated organization.

## Verification

43 isolated HTTP regression checks use the actual JWT and permission guards with signed test tokens; session storage and product service are mocked. They cover all eight endpoints, exact/opposite/unrelated/no permissions, absent sessions, browser cookies and JWT tampering.

A real PostgreSQL integration test uses the complete app, active sessions, two synthetic organizations and valid restricted test JWTs. It verifies 401/403 writes leave product and audit snapshots unchanged; permitted create/update/status operations persist and produce six audit events; a second organization's manager cannot list or mutate the first organization's products. Restricted JWTs exercise signed-claim enforcement, not role-assignment administration.

No production deployment, migration, role-template change, or financial posting is included. Real PostgreSQL results must be recorded after CI completes; passing mocked-service tests alone does not establish persistence acceptance.

## Authorized loan update discovered during verification

CI #112 reproduced a 500 on the authorized loan-product edit path: ProductsService updated loan_products.updated_at, but migration 0009 and the current schema contain no such column. Loan status updates had the same assumption. Match these two queries to the existing schema; retain savings updated_at updates. The real database test exercises both edit and status paths and must pass before reporting this recovery complete. No schema migration is required.
