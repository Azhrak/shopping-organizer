# Scheduled checks

`check-due.ts` runs one pass over every item whose `next_check_at` has come
due. It calls the same `checkAllDue()` the `POST /api/cron/check` route calls,
so the two surfaces cannot drift apart — pick whichever fits the host.

```sh
pnpm check:due                       # one pass with the defaults
pnpm check:due -- --dry-run          # list what is due, contact no store
pnpm check:due -- --json             # one JSON object, for log ingestion
pnpm check:due -- --limit=50 --concurrency=2
```

Needs `DATABASE_URL`. The npm script passes `--env-file=.env`; a system
scheduler should supply the environment itself (see the unit below).

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Ran. Individual items may still have failed — see the output. |
| 1 | Every attempted item failed, or the run itself threw. |
| 2 | Bad arguments, or `DATABASE_URL` missing. |

A partial failure is deliberately **not** an error exit: one dead store must
not mark the whole run bad and trigger a scheduler alert. A run where nothing
succeeded is worth waking someone for.

## Pacing

Defaults live in `DEFAULT_SCHEDULER_OPTIONS` (`src/lib/services/scheduler.service.ts`):
100 items per run, 4 extractions in flight, 2000 ms minimum between two
requests to the *same* hostname.

The per-host gate matters more than the concurrency cap: without it, four
workers could all pull items from one store and hit it simultaneously. Items
that fail back off exponentially (`nextCheckDelayHours`), so a URL that 404s
is retried on a widening interval instead of every run.

Run this more often than your check interval — the backoff decides what is
actually due, not the cron schedule. Every 30 minutes against a 12-hour base
interval is reasonable.

## systemd timer

```ini
# /etc/systemd/system/hintavahti-check.service
[Unit]
Description=Hintavahti scheduled price check
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/srv/hintavahti
Environment=NODE_ENV=production
EnvironmentFile=/srv/hintavahti/.env
ExecStart=/usr/bin/env pnpm exec tsx scripts/check-due.ts --json
User=hintavahti
```

```ini
# /etc/systemd/system/hintavahti-check.timer
[Unit]
Description=Run the Hintavahti price check every 30 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=30min
# Avoid every host on the internet hitting stores exactly on the half hour.
RandomizedDelaySec=5min
Persistent=true

[Install]
WantedBy=timers.target
```

```sh
systemctl enable --now hintavahti-check.timer
journalctl -u hintavahti-check.service -f
```

## crontab

```cron
*/30 * * * * cd /srv/hintavahti && /usr/bin/pnpm check:due --json >> /var/log/hintavahti-check.log 2>&1
```

## Via the HTTP route instead

If the scheduler cannot reach the database directly — a hosted cron service,
say — post to the running app instead. Same logic, same pacing:

```sh
curl -fsS -X POST https://hintavahti.example/api/cron/check \
  -H "x-hintavahti-secret: $INGEST_SECRET"
```

`-f` makes curl exit non-zero on an HTTP error, so the scheduler notices a 401
or 503 rather than silently logging it.
