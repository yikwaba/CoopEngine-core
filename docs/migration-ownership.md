# Who owns what, and why migrations cannot be rewritten

## The incident this prevents

Two agents worked on this repository at once. One deleted two already-applied migrations
(`0036_ledger_immutability`, `0037_ledger_guard_refinements`) and added a different `0036` in their
place. Nothing failed: the test suite was green, CI was green, and the ledger silently lost its
immutability guards. It was caught only because the push was rejected and someone looked.

The lesson is not "be careful". Carefulness is not a control. Two controls now exist.

## 1. The migration history is append-only (enforced in code)

`scripts/verify-migration-history.mjs` records a sha256 of every applied migration in
`packages/db/migrations/CHECKSUMS.json` and fails on:

- a **deleted** migration — environments have already run it;
- a **modified** migration — environments ran the old bytes, so the change is a new migration;
- **two migrations sharing a numeric prefix**;
- an **unrecorded** `.sql` file — new migrations are accepted deliberately with `--record`;
- an applied migration **missing from** `meta/_journal.json`.

It runs in `scripts/verify-all.sh` and in CI, so the repository cannot verify green while its history
has been rewritten. Its own effectiveness was tested by simulating the exact incident.

**Adding a migration:** create it, then `node scripts/verify-migration-history.mjs --record`, and
commit the updated `CHECKSUMS.json` alongside it. That is the only legitimate use of `--record`.

**Grandfathered wart:** two `0034_` files predate the gate. Renaming either would itself rewrite
applied history, so both are listed in the manifest with the reason. Resolve them when the database is
next rebuilt from scratch.

## 2. One owner for the collision zone (declared, needs one click to enforce)

`CODEOWNERS` and `packages/db/OWNERS` assign `packages/db` — migrations, guard functions, seed, pool —
to a single owner. Working there concurrently is what caused the incident.

**To make GitHub enforce it** (cannot be automated from here: this environment holds no GitHub API
token, by policy — only a deploy key):

1. Repository → **Settings** → **Branches** → **Add branch protection rule**.
2. Branch name pattern: `main`.
3. Enable **Require a pull request before merging**.
4. Enable **Require approvals**, set to **1**.
5. Enable **Require review from Code Owners**.
6. Optionally enable **Do not allow bypassing the above settings**.

After that, no agent — including the one that owns `packages/db` — can push to `main` directly. Work
lands through a pull request, and a rewritten migration is refused by CI before it can be merged.

## 3. Working agreement for parallel agents

- One agent at a time owns `packages/db`. Announce it, or use a branch.
- Everything else: branch + pull request, never a direct push to `main`.
- If a push is rejected because the remote moved, **stop and read what arrived** before merging. That
  single habit is what turned the incident into a two-hour reconciliation instead of silent data loss.
- `verify-all.sh` is the arbiter, not a green CI badge on a branch that never ran it.
