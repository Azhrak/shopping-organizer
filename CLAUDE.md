# Hintavahti

Setup, scripts and architecture are in [README.md](README.md). What follows is
only what the code cannot tell you.

## extractPrice is a placeholder that throws

`src/lib/extraction/extractPrice.server.ts` is not implemented. It throws
rather than returning a fake price, so anything that tracks a price fails at
runtime until the real module is dropped in. Do not write code assuming it
works, and never make it return a plausible value to get past an error.

Keep its `import "@tanstack/react-start/server-only"` line — that is what keeps
cheerio and outbound fetch out of every client bundle.

## Prices: major units in, minor units stored

`PriceResult.price` is in MAJOR units (`1299.00`). Everything stored is an
integer in MINOR units (cents) — never a float. `toMinorUnits()` converts at
the boundary in `items.service.ts`.

If a replacement extractor returns cents already, fix the call site in
`items.service.ts`. Never change the database or the pricing maths to match —
a wrong guess here writes prices off by 100x and nothing catches it.

## Services take their dependencies as arguments

Nothing under `src/lib/services/` or `src/lib/core/` may import from
`@tanstack/react-start`. The database handle and the extractor are passed in
(`ServiceDeps`), not imported.

This is what lets the UI's server functions, the extension's `/api/ingest`
route and the cron script call the same `addItem()` and `checkAllDue()`. Reach
for the module registry instead and those three surfaces start to drift.

## Never remove the CSRF middleware from src/start.ts

Defining `src/start.ts` at all disables Start's default CSRF middleware, so the
explicit `createCsrfMiddleware` registration there is the only thing protecting
server functions. The missing-middleware warning is dev-only — dropping it
would ship an unprotected production build silently.

Its `handlerType === "serverFn"` filter is deliberate: it exempts `/api/ingest`
and `/api/cron/check`, which authenticate by shared-secret header instead.

## A failed check writes no price_checks row

`price_checks` is a pure record of observed prices, so no stats query can
average over nulls. Failures are recorded on the item instead
(`consecutive_failures`, `extract_failing`) with exponential backoff. Keep it
that way — do not insert a null or sentinel price to represent a failure.
