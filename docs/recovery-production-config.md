# Production configuration guards — REC-05 / F10

Production previously required only a present JWT signing secret. OTP could return development codes and payments could create simulated accounts or use an implicit sandbox endpoint.

The API now validates configuration when ENV loads, before Nest starts. Production requires explicit Termii and Monnify modes, configured provider credentials, an account-specific HTTPS Termii origin and Monnify's live origin. JWT and internal job secrets must have at least 32 characters, character variety and no placeholder/default value. Browser origins must be explicit HTTPS origins. Invalid token lifetimes and misspelled provider/environment modes fail in every environment. Error messages report variable names and rules without configured secrets.

NODE_ENV=production is required when COOPENGINE_ENVIRONMENT marks production, and production cannot enable isolated-staging captures. Development/test defaults and isolated staging simulations remain supported. There is no database migration.

## Operator requirements

Before any production rollout, configure NODE_ENV=production, JWT_ACCESS_SECRET, INTERNAL_CRON_TOKEN, MEMBER_OTP_PROVIDER=termii, TERMII_API_KEY, TERMII_SENDER_ID, TERMII_BASE_URL, MONNIFY_PROVIDER=monnify, MONNIFY_API_KEY, MONNIFY_SECRET_KEY, MONNIFY_CONTRACT_CODE, MONNIFY_BASE_URL=https://api.monnify.com and CORS_ORIGINS. Obtain secrets privately and generate strong random signing/job secrets. PORTAL_PUBLIC_URL, if supplied, must be an HTTPS origin. Missing or unsafe values intentionally stop startup; review deployment configuration before rollout. Do not copy synthetic test fixtures as credentials.

Termii assigns account-specific base URLs: copy the origin from the account dashboard rather than assuming a region. See https://developers.termii.com/ and https://developers.monnify.com/docs/live for provider settings.

## Verification and acceptance

API typecheck/build and 338 unit tests passed locally, including 61 new checks. Compiled ENV subprocess tests prove invalid production exits, valid synthetic production loads and canonicalizes CORS origins, and isolated staging loads. Full CI checks remain the installation gate.

The user reported PR #8 installed and logout/navigation working on 4 October 2026 around 10:30 Africa/Lagos. This is local UI acceptance, separate from production acceptance.

## Remaining recovery work

This closes the startup-configuration slice of F10, not all REC-05. Actual provider credential validity, delivery, payment reconciliation and existing simulated records require separate acceptance. Presence/length/variety checks cannot establish secret entropy. The app cannot discover an operator's undeclared production environment when both environment flags are omitted. MFA enrollment/recovery/step-up and remaining authentication lifecycle gaps remain open. No production deployment or live provider call was performed.
