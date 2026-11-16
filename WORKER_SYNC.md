# Safely syncing this repository with the running Worker

## Current state

- `goldlexx/PrideOneTg` is a source mirror for a Telegram bot that is already deployed and working in Cloudflare Workers.
- A read-only `wrangler deployments list --name pride-one-bot` confirmed that a Worker with this script name has existing deployments. No deployment, webhook change, or data migration was performed for this check.
- The local `wrangler.jsonc` describes `pride-one-bot`, `src/index.js`, compatibility date `2025-10-01`, `BRANCH_DO` → `BranchBookingDO`, migration tag `v1`, `PRIDE_KV`, an hourly cron, and `workers_dev`. It has no tracked `vars`; branch-specific mapping belongs in the runtime environment. `keep_vars` is enabled.
- `.dev.vars` and `.secrets.deploy.env` are local-only and ignored. Never commit them or print their values.
- The deployment listing proves the Worker exists, but does **not** prove that the deployed script, bindings, KV namespace, Durable Object migration history, secrets, routes, or webhook target match this repository. That parity review is still required before any production update.

## Read-only parity review required before deploy

In the Cloudflare dashboard, select the account that owns the live Worker and compare the following with `wrangler.jsonc` and this repository:

1. Account ID and script name are the account and `pride-one-bot` Worker that currently serves Telegram traffic.
2. Production Worker compatibility date and entry point match the intended source.
3. `BRANCH_DO` points to `BranchBookingDO`; the live migration history already includes the expected SQLite class. Never rerun or alter a migration to make it appear to match.
4. `PRIDE_KV` points to the existing namespace that holds production data.
5. Cron schedule, Workers.dev/custom routes, and static asset bindings are preserved.
6. Required runtime variables and secret **names** are present. Check values only in the Cloudflare dashboard; do not copy or disclose them.
7. The Worker URL still matches the Telegram webhook. Do not reset the webhook as part of a GitHub sync.

If any item is unknown or differs, stop. Do not dispatch deployment, run `wrangler deploy`, call `/admin/webhook`, or call `/admin/migrate`.

## Guarded GitHub workflow

- Pushes to `main` run install, Mini App build, tests, and `wrangler deploy --dry-run`; they never deploy production.
- Production deploy is available only through `workflow_dispatch` on `main`, with the required `confirm_existing_worker` checkbox enabled after the parity review above.
- Before deploy, the workflow makes a read-only Cloudflare API request to verify that `pride-one-bot` exists in the selected account. If the account ID, API token, or Worker cannot be verified, it aborts; it does not create a Worker.
- To make the guarded workflow available, set repository variable `CLOUDFLARE_ACCOUNT_ID` and a narrowly scoped repository secret `CLOUDFLARE_API_TOKEN`. The token needs permission to read the existing script for the guard and update Workers for deployment. Do not use a global API key.
- A successful existence check is not a substitute for configuration parity. The person dispatching the workflow must make the explicit confirmation only after completing the checklist.

The workflow and this document are preparation only. No production deployment has been run from this repository.
