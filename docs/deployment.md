# Deployment

Use a separate bot and test group to validate this Alpha release. Back up the
SQLite database before upgrades. First run the Quick start in the README.

## HTTPS, webhook and Cap

1. Set a hostname and terminate HTTPS with a reverse proxy on the bot host.
2. Configure `WEBHOOK_URL`, `WEBHOOK_SECRET`, `WEBHOOK_PORT`, `CAP_PUBLIC_URL`
   and `CAP_SECRET` in the private environment file. Generate independent secrets,
   for example with `openssl rand -hex 32`. The webhook and Cap URLs must share
   an HTTPS origin and have different, non-root paths.
3. Proxy `/tg/` and `/guard/` to `http://127.0.0.1:8788`. Keep the Bun listener
   local; cap request bodies at 1 MiB. Do not cache or challenge these routes.
   Preserve `X-Telegram-Bot-Api-Secret-Token` and the request body.
4. In BotFather, enable the bot's Main Mini App and use the Cap page URL
   (for example `https://bot.example.com/guard/verify`). Restart the bot after
   changing this setting so it refreshes `has_main_web_app`.
5. Start the bot. It registers its webhook without dropping pending updates.
   Test a new arrival, a join request, a wrong answer, a timeout and review.

A proxy such as Cloudflare may sit in front of the hostname. Use Full (strict)
TLS with a valid origin certificate. Bypass cache and interactive bot challenges
for the webhook and Cap routes, including their subpaths. Do not cache authenticated
responses. Disabling a generic bot challenge does not disable webhook-secret or
Mini App signature checks in this application.

## Process supervision

`ecosystem.config.json` is an example for `/srv/apps/ingress-guard`, Bun at
`/opt/bun/bin/bun`, and one PM2 process named `ingress-guard`. Adjust paths before
use. Run as a dedicated unprivileged account. Keep database, `.env`, temporary
files and backups private. Configure compressed, bounded log rotation separately.

```sh
pm2 start ecosystem.config.json
pm2 save
```

The optional `ops/apply-release.sh` is for an existing installation using the
example paths, account `appsvc`, `/usr/local/bin/pm2` and `/var/lib/appsvc` home.
It expects a complete candidate at `<app>/backups/releases/<id>/candidate` with
installed dependencies, built artwork, a validated bank, tests already passed,
and the same database migration checksums. It does not install a server or stage
files remotely. Inspect and adapt the script before using it. Cutover creates a
consistent DB backup and retains the previous code; failures restore previous
code. It refuses implicit schema changes. Database downgrade is never automatic.

## Assets, upgrades and recovery

Build banks offline with `bun run boards:build -- <new-output-directory> 300`.
Replace the active bank only while stopped, along with the matching manifest and
asset files. Keep old assets and code available for rollback. Demo geometric
artwork is for integration testing; supply properly licensed production artwork.

Run `bun --env-file=.env scripts/backup.ts /absolute/private/backup-directory`
while stopped, or accept a short write stall. The backup script checks integrity
and retains the newest seven snapshots. Store an off-host copy under your policy.
Restore only with the process stopped, including SQLite WAL handling; preserve the
current files before replacing them. Verify schema compatibility and run a test
join after recovery. Telegram side effects already sent cannot be rolled back.

`ops/preflight.ts` checks candidate assets, configuration and schema read-only.
`ops/check-runtime.ts` consumes PM2 JSON on stdin and checks a matching startup
marker plus the local Cap page when enabled. These are readiness checks, not a
full human verification acceptance test. Never print PM2's complete environment.
