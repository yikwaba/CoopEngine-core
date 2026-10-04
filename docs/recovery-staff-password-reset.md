# Staff password recovery — REC-03 / FR-004 / audit F09

## Implemented slice

Staff login links to /forgot-password; reset email links open /reset-password. POST /auth/password-reset/request responds with the same 202 body for active, unknown, inactive and throttled accounts. Limits are five requests per normalized email and twenty per IP in fifteen minutes, enforced through shared PostgreSQL counters/advisory locks. Responses have a three-second floor outside tests; SMTP has a 2.5-second deadline. Slow database failures remain failures; this is not a guarantee of indistinguishable timing during infrastructure outages. IPs come from the existing Express request.ip boundary, not arbitrary forwarded headers; verify trusted proxy configuration before production to avoid all clients sharing one bucket.

Tokens contain 32 cryptographically random bytes, expire after fifteen minutes and are stored only as SHA-256 digests. Email uses a configured origin, never request Host. The token is in the URL fragment and is removed from browser history after loading; it is not put in query strings or localStorage. The portal sets no-referrer. Confirmation validates 12–72 character passwords and the bcrypt 72 UTF-8 byte limit.

Successful confirmation atomically changes the token owner's password, consumes all their remaining reset links, revokes existing staff sessions and records a global identity audit event without secret metadata. It clears browser cookies and requires normal login. Existing MFA enrollment/challenges are preserved. Concurrent use of a link has one winner. Reset never selects a target user/tenant from request parameters.

Migration 0041 appends two **global identity** tables (password_reset_tokens and password_reset_requests), consistent with global users/sessions. These are deliberately not tenant tables: unauthenticated recovery occurs before tenant selection. They have no tenant/member/export API. This does not claim every RLS/access boundary is accepted. Existing migration files/checksums are unchanged; the journal/checksum registry append the new file. Follow the existing custom-SQL migration convention (approval migrations also have no generated schema snapshots).

## Delivery configuration

Production requires NODE_ENV=production, PORTAL_PUBLIC_URL=https://app.coopengine.com.ng (origin only), SMTP_HOST and SMTP_FROM; SMTP_PORT defaults to 587, with SMTP_USER/SMTP_PASS where required. TLS is mandatory (implicit on 465, STARTTLS otherwise); TLS verification is retained. Delivery failure invalidates that token and returns the generic response; logs contain no recipient, link, password or SMTP credentials. No production provider message was sent by this change. Provider delivery and proxy configuration acceptance remain required before production use. Durable delivery retries belong to REC-24; users can request a new link after failure.

In the existing isolated local Docker environment only, if SMTP is absent, capture is allowed solely for addresses ending @recovery.invalid. Captured mail goes to API-container /tmp/coopengine-reset-mail (0700 directory, 0600 files). Each filename is the SHA-256 digest of the recipient; latest request replaces that recipient's capture. The link origin defaults to http://localhost:4310. This capture cannot be activated when NODE_ENV=production. No reset token is returned through the public API or written to application logs. Container recreation loses captures; request again afterwards.

## Staging installation and acceptance

Copy changed apps/api and apps/portal plus packages/db/migrations from the pinned PR commit into the existing recovery folder, retaining .staging/compose.env secrets. Update STAGING_SOURCE_SHA. Build the API image; run the existing `migrate` service once to append 0041 and refresh staging_app grants; then recreate API and portal using that image and restart gateway. Do not reseed synthetic fixtures or remove volumes. Back up the synthetic staging database before the schema change. No production migration is authorized here.

Use the tenant B synthetic staff account for UI recovery so the primary tenant A login remains available. After requesting a link, read only that synthetic recipient's captured file locally and open its link. Never paste tokens/passwords into chat. Set a new password, verify the old one fails and the new one signs in; reopening the consumed link must fail. Keep the chosen synthetic password privately. Verify expiry, generic unknown-email response and no false logout on errors as applicable.

## Verification and boundaries

Local checks: API unit/HTTP/permission tests, portal regression tests, API/portal typechecks, API/Next production builds, append-only migration checks and static HTTP page smoke. Full CI with real PostgreSQL is required on the draft PR. Added database checks cover known/unknown/inactive accounts, hashing, expiry, owner scoping, old login/session/refresh rejection, replay/concurrency/sibling invalidation, email/IP throttling, provider failure, MFA preservation and rollback when audit insertion fails.

The existing sign-in/refresh implementation's broader concurrent issuance/revocation behavior is not closed by this slice; REC-03 session concurrency/refresh acceptance remains open. Password recovery is not MFA recovery. Production email delivery, interactive local UI acceptance, other access-control cards and commercial acceptance remain open. PR #6 was reported installed locally on 4 October; that report is not a fresh restricted-role UI matrix.

Design references: https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html and https://nodemailer.com/smtp .
