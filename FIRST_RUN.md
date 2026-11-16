# Legacy first-run guide (archived)

> [!CAUTION]
> PRIDE ONE is already running in Cloudflare Workers and this repository mirrors that service. This file is not a deployment runbook. Do not deploy from historical instructions, reset the Telegram webhook, run `/admin/migrate`, or roll back a Worker version.

The previous first-run procedure mixed initial provisioning, webhook setup, KV migration, secret management, and production deployment commands. Those actions can change the live Worker or booking data, so the operational commands have been removed from this guide.

For a repository-to-Worker parity review, use [`WORKER_SYNC.md`](WORKER_SYNC.md). It describes the read-only checks required before a later production update and the GitHub workflow's explicit confirmation gate. GitHub pushes run tests and a Wrangler dry-run only; they do not deploy production.

`UPDATE_2.0.2.md` is retained as historical context for the one-time 2.0.1 → 2.0.2 migration. Do not repeat that migration against the running service.
