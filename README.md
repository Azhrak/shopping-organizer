# Hintavahti

Track the price of things you are thinking about buying, and get told when one
of them actually drops.

Save a product URL — one at a time in the app, or every open tab at once from
the Chrome extension. The server re-fetches each page on a schedule, records
the price, and flags a drop when the new price beats your target or the
trailing 90-day low. Items live in folders, can be filtered by saved views
("dropped", "at target"), and up to four of them can be put side by side in a
comparison group.

## Stack

TanStack Start (React 19, file-based routing, SSR) · Kysely + PostgreSQL 17 ·
Tailwind 4 · Zod 4 · Vitest · Biome · pnpm 10 / Node 24.

## Getting started

```sh
pnpm install
cp .env.example .env          # then edit it — see below
pnpm db:up                    # Postgres 17 + Adminer via docker compose
pnpm db:migrate
pnpm dev                      # http://localhost:3000
```

Adminer is on <http://localhost:8201>; the database itself is published on host
port **5434**, not 5432, so it does not collide with a local Postgres.

### Environment

`.env.example` documents every variable. The two that need real values before
anything external works:

| Variable | Why |
| --- | --- |
| `INGEST_SECRET` | The only gate on `POST /api/ingest` and `POST /api/cron/check`. The literal `change-me` is rejected on purpose. |
| `EXTENSION_ORIGIN` | The `chrome-extension://<id>` origin allowed to call `/api/ingest`. Echoed back rather than wildcarded. |

Generate a secret:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### One thing you must supply

`src/lib/extraction/extractPrice.server.ts` is a **placeholder that throws**.
It does not return a plausible-looking fake price, so nothing can silently
record invented data. Replace the whole file with a module exporting:

```ts
export async function extractPrice(url: string): Promise<PriceResult>
```

following the cascade JSON-LD → microdata → OG meta → per-site CSS selectors,
returning `ok: false` rather than guessing. Keep the
`import "@tanstack/react-start/server-only"` line — it is what keeps cheerio
and outbound fetch out of every client bundle.

The service layer treats `PriceResult.price` as **major** units (`1299.00`) and
converts to integer minor units before storing. If your module already returns
cents, change the call site in [items.service.ts](src/lib/services/items.service.ts),
not the database.

## Scripts

| Command | Does |
| --- | --- |
| `pnpm dev` | Dev server on :3000 |
| `pnpm build` / `pnpm start` | Production build / preview |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` / `pnpm lint:fix` | Biome check / autofix |
| `pnpm db:up` | Start Postgres + Adminer |
| `pnpm db:migrate` | Run migrations |
| `pnpm db:migrate:test` | Same, against `TEST_DATABASE_URL` |
| `pnpm db:codegen` | Regenerate `src/lib/db/types.ts` from the live schema |
| `pnpm test` / `pnpm test:run` | Unit tests (watch / once) |
| `pnpm test:integration` | Integration tests — needs a running database |
| `pnpm check:due` | One scheduled-check pass |

Integration tests share one database and truncate between tests, so they run
serially (`fileParallelism: false`). Run `pnpm db:migrate:test` first.

## How it fits together

```text
routes/          TanStack Start pages + the two external API routes
lib/server/      Server functions (in-app UI surface, CSRF-protected)
lib/services/    Business logic — framework-agnostic, no Start imports
lib/core/        Pure functions: pricing maths, concurrency helpers
lib/db/          Kysely handle, migrations, generated types
lib/extraction/  extractPrice — the module you supply
```

The services layer takes its database handle and extractor as arguments rather
than importing them. That is what lets the in-app UI, the extension route and
the cron script all call the *same* `addItem()` and `checkAllDue()` — there is
one implementation of "add an item", not three that drift.

### Prices

Stored as **integer minor units** (cents) everywhere — never floats. All
timestamps are `timestamptz` in UTC.

### Drop detection

A new price is a drop only when all three hold:

1. It fell against the previous check. A first-ever check is never a drop.
2. It is at or below your target price, **or** below the trailing 90-day low.
3. It is strictly below the price we last alerted at.

Rule 3 is the dedupe. A price oscillating between 90 and 100 alerts once at 90,
and again only if it goes below 90.

### Failures

A failed extraction writes **no** `price_checks` row — that table stays a pure
record of observed prices, so no stats query can average over nulls. The
failure is recorded on the item instead (`consecutive_failures`,
`extract_failing`) and the next check backs off exponentially, up to a week.

Adding a URL whose price cannot be extracted still **saves** it, flagged as not
tracking. A saved-but-untracked item can be fixed later; a dropped URL cannot.

## Scheduled checks

`checkAllDue()` picks up every item whose `next_check_at` has passed. Two ways
to trigger it, same logic either way:

```sh
pnpm check:due                        # direct database access
```

```sh
curl -fsS -X POST https://hintavahti.example/api/cron/check \
  -H "x-hintavahti-secret: $INGEST_SECRET"
```

Defaults: 100 items per run, 4 extractions in flight, 2000 ms minimum between
two requests to the *same* hostname. The per-host gate matters more than the
concurrency cap — without it, four workers could all pull items from one store
and hit it at once.

Run it more often than your check interval (every 30 min against the 12-hour
base interval is reasonable); backoff decides what is actually due, not the
cron schedule. systemd unit, crontab line and exit codes are in
[scripts/README.md](scripts/README.md).

## Chrome extension

[extension/](extension/) is a Manifest V3 extension with one button: capture
every open http(s) tab and POST it to `/api/ingest`. No content scripts — the
server fetches and parses each page itself, so it never reads page content and
needs no per-site permission. Load-unpacked steps and troubleshooting are in
[extension/README.md](extension/README.md).

## Security notes

`src/start.ts` replaces Start's default CSRF middleware with one filtered to
`handlerType === "serverFn"`. Defining that file at all disables the default
entirely, so the middleware **must** stay registered there — the
missing-middleware warning is dev-only and a production build would ship
unprotected server functions silently.

That filter is what exempts `/api/ingest` and `/api/cron/check`: they are
server routes, called by an extension and a scheduler that cannot send
same-origin `Origin`/`Referer` headers. Their only gate is the
`x-hintavahti-secret` header, compared in constant time.
