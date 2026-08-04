# Design: user-pointed price selection

Status: **proposed, not implemented**. Written for review before any code.

## Problem

`extractPrice` runs a cascade — JSON-LD → microdata → OG meta → per-host CSS
selectors — and returns `ok:false` rather than guessing when none of them find a
price. That is correct behaviour, but it leaves two real gaps:

1. **Stores the cascade cannot read.** The price exists in fetchable HTML, but
   only as rendered text with no structured markup. Today the only fix is
   hardcoding a selector in `SITE_SELECTORS` in `src/lib/extraction/parse.ts`,
   which requires a code change and a deploy per store.
2. **Stores the server cannot fetch.** Gigantti and Power return HTTP 429 to the
   server-side fetch. No selector helps, because there is no real HTML to apply
   it to.

This feature targets gap 1 directly, and softens gap 2 by capturing a real price
at pick time. It does **not** claim to solve gap 2 — see Limitations.

## Scope (decided)

**Selector + captured value at pick time.**

The user points at the price in their browser. The extension sends both:

- the **selector** it derived, stored on the item and used by the server-side
  cascade on every later check;
- the **price the browser actually observed**, used to seed the item so it is
  never created empty.

Out of scope for this iteration: re-reading the selector on every subsequent
visit (the "full client-side capture" option). Noted in Future work.

## User-visible flow

1. User is on a product page whose price Hintavahti could not read.
2. Clicks the extension → **"Point at the price"**.
3. The page enters pick mode: hovering outlines the element under the cursor and
   shows the text that would be captured.
4. Click confirms. Escape or right-click cancels.
5. The extension derives a selector, re-queries it to confirm it finds the same
   element, parses the text as a price, and shows a confirmation: *"Track
   14,99 € from this element?"*
6. On confirm it POSTs to `/api/ingest`; the item is created or updated with the
   selector stored and the observed price recorded as its first price check.

If the picked element's text does not parse as a price, the extension says so
and stays in pick mode. It never sends an unparseable value.

## Architecture

The existing constraint holds: business logic stays in the framework-agnostic
service layer, and both the UI's server functions and the extension's route call
the same `addItem()`.

```
extension (content script)          server                        db
─────────────────────────────────────────────────────────────────────────
user clicks element
  │
  ├─ derive selector  ──────┐
  ├─ read element text      │
  └─ parse to major units   │
                            ▼
              POST /api/ingest
              { urls:[{ url, priceSelector, observedPrice }] }
                            │
                            ▼
                  addItem(deps, url, {
                    priceSelector,
                    observedPrice,
                  })
                            │
              ┌─────────────┴─────────────┐
              │                           │
      no observedPrice:            observedPrice given:
      extractPrice(url) as today   trust it, skip the fetch
              │                           │
              └─────────────┬─────────────┘
                            ▼
                   toMinorUnits() at the boundary
                            ▼
              items.price_selector + price_checks row
```

Later cron checks call `checkItem()` unchanged; the only difference is that
`parseProductHtml` now tries the item's stored selector before the generic
cascade.

### Why the selector is passed into the parser, not read from the DB inside it

`parse.ts` stays pure — HTML string plus options in, `PriceResult` out. The
service layer reads `price_selector` off the item row and passes it down through
`ExtractPriceFn`. This keeps `parse.ts` unit-testable without a database and
preserves the "services take their dependencies as arguments" rule.

This does mean `ExtractPriceFn` grows an options parameter:

```ts
export type ExtractPriceFn = (
  url: string,
  options?: { priceSelector?: string | null },
) => Promise<PriceResult>;
```

Optional, so every existing caller and the test doubles in
`items.service.integration.test.ts` keep compiling unchanged.

## Schema change

New migration `002_price_selector.ts`:

```ts
await db.schema
  .alterTable("items")
  .addColumn("price_selector", "text")
  .execute();
```

Nullable, no default, no backfill. A null selector means "cascade only", which
is exactly today's behaviour, so every existing row keeps working.

`extract_method` needs **no** change: a user selector reports as the existing
`"selector"` enum value. The distinction between a hardcoded and a user-picked
selector is recoverable from `price_selector IS NOT NULL`, so it does not need
its own enum member.

A second nullable column, `price_selector_failing boolean not null default
false`, records that a stored selector stopped matching. Kept separate from
`extract_failing` so the UI can say *"your selector broke"* — a fixable,
user-actionable state — rather than the generic *"extraction failed"*.

## Selector generation — the actual hard part

The picker UI is straightforward. Producing a selector that still works next
week is not. A naive `nth-child` path from `document.body` breaks the first time
the store adds a promo banner, and hashed CSS-module classes (`.css-1x9f2a`)
change on every deploy.

Strategy, in priority order. Each candidate is **validated** by re-querying the
document and confirming it matches exactly one element, and that it is the
element the user clicked. The first candidate that validates wins.

1. **Semantic price attributes** — `[itemprop="price"]`, `[data-price]`,
   `[data-test-id=…]`, `[data-testid=…]`, `[data-cy=…]`. Test hooks and
   microdata are the most stable things on a retail page, because changing them
   breaks the store's own tests.
2. **Stable `id`** — `#product-price`. Rejected if it looks generated: matches
   `/\d{4,}/` or `/^[a-f0-9-]{16,}$/i`.
3. **Stable class** — a class that is not hashed. Rejected if it matches
   `/^css-/`, `/^sc-/`, `/^[a-z]{1,3}\d{3,}$/i`, or contains a 6+ hex run.
   Combined with the tag name and, if needed, one stable ancestor.
4. **Scoped structural path** — shortest `tag:nth-of-type(n)` chain from the
   nearest ancestor that itself has a stable anchor. `nth-of-type` beats
   `nth-child` because it is unaffected by sibling elements of other tags being
   inserted.

If nothing validates, the extension reports that it could not derive a stable
selector rather than storing a fragile one. Same principle as the extractor: no
plausible-looking guess.

**This logic must be unit-tested against fixture DOMs**, including the
adversarial cases: hashed classes, duplicated matches, generated ids, an element
that appears twice on the page. I would put it in
`src/lib/extraction/deriveSelector.ts` — pure, no DOM globals beyond a passed-in
root — and have the content script import the bundled copy, so the same code is
covered by the Vitest suite rather than living untested in `extension/`.

## Parser change

`parseProductHtml(html, url, options)` gains an optional `priceSelector`. When
present it runs **first**, before JSON-LD:

```ts
if (options?.priceSelector) {
  const picked = fromUserSelector($, options.priceSelector);
  if (picked.price !== null) return { ...picked, method: "selector" };
  // fall through to the cascade, and let the caller record that the
  // user selector stopped matching
}
```

Rationale for running first: the user pointed at the number they care about. If
a page has both a JSON-LD price (the base model) and the user picked the variant
they actually want, their choice should win.

Falling through rather than failing hard is deliberate — a broken selector
should degrade to the normal cascade, not turn a working item into a failing
one. The `price_selector_failing` flag is what surfaces it.

## API change

`ingestSchema` currently accepts `{ urls: string[] }`. It becomes a union so the
existing bulk "grab open tabs" path is untouched:

```ts
const ingestEntrySchema = z.union([
  z.string().min(1),
  z.object({
    url: z.string().min(1),
    priceSelector: z.string().min(1).max(500).optional(),
    observedPrice: z.number().positive().finite().optional(),
    observedCurrency: z.string().length(3).optional(),
  }),
]);

const ingestSchema = z.object({
  urls: z.array(ingestEntrySchema).min(1).max(MAX_URLS),
});
```

A bare string keeps meaning exactly what it means today. Auth is unchanged —
same `x-hintavahti-secret` header, same CSRF exemption via the `handlerType ===
"serverFn"` filter in `src/start.ts`.

### Units, stated explicitly

`observedPrice` crosses the wire in **MAJOR units** (`14.99`), matching
`PriceResult.price` and the existing extractor contract. `addItem` converts via
`toMinorUnits()` at the same boundary it already does. No new conversion site,
and nothing in the database or the pricing maths changes.

The extension parses the element's text into major units before sending, reusing
the same separator rules as `parsePriceString` — `1.299,00` and `1,299.00` both
mean 1299, and an ambiguous string is refused rather than guessed. That function
should be shared with the extension bundle rather than reimplemented, so the two
cannot drift.

## Trust model

`observedPrice` is supplied by the client, and the extension is authenticated by
the shared secret. In a single-user self-hosted app the client is the user, so
this is not a privilege boundary — but the value is still validated: finite,
positive, and within a sane ceiling, so a typo or a mis-parse cannot write a
nonsense price that the stats queries then average over.

`priceSelector` is stored and later fed to cheerio server-side. Cheerio's
`$(selector)` is a query, not an evaluator, so a malicious selector cannot
execute anything — but length is capped at 500 chars to keep pathological
selectors from becoming a CPU sink during a cron run over every item.

## Testing plan

Unit (no DB, no network):

- `deriveSelector` against fixture DOMs: semantic attribute wins over class;
  hashed class rejected; generated id rejected; duplicate match rejected;
  nothing stable → returns null.
- `parseProductHtml` with `priceSelector`: user selector beats JSON-LD; broken
  selector falls through to the cascade; selector matching a non-price string
  falls through rather than storing garbage.
- Shared price-string parsing already covered by `parse.test.ts`.

Integration (real Postgres):

- `addItem` with `observedPrice` creates the item, stores the selector, and
  writes exactly one `price_checks` row at the right minor-unit value.
- `addItem` with `observedPrice` does **not** call the extractor (assert via the
  queue-based test double already in `items.service.integration.test.ts`).
- Re-adding a URL that is already tracked updates the selector instead of
  creating a duplicate.
- `checkItem` on an item with a stored selector passes it through to the
  extractor.

Real-run verification, per the standing rule that typecheck and tests are not
enough:

- Load the unpacked extension, pick a price on a live store page, confirm the
  item appears with the correct value and Finnish formatting.
- Confirm the stored selector still resolves on a fresh server-side fetch.

## Limitations — stated plainly

- **This does not fix Gigantti or Power.** They 429 the server-side fetch. A
  user-picked selector will capture a correct price at pick time and then fail
  on every cron check, leaving the item in the same failing state as today, just
  with one real price recorded. Fixing that needs the extension to re-read the
  price on later visits, which is deliberately out of scope here.
- **Client-rendered prices are captured, not tracked.** If the price only exists
  after JavaScript runs, the picker sees it but a server-side fetch never will.
  Same outcome as above.
- **A stored selector will eventually break.** Stores redesign. The design
  degrades to the cascade and flags `price_selector_failing` rather than
  silently reporting a wrong number, but the user has to re-pick.
- **The picker cannot run on `chrome://` pages or the Chrome Web Store**, per
  Chrome's restrictions. The popup should disable the button there rather than
  fail on click.

## Extension changes

`manifest.json` needs `"scripting"` added to `permissions`. Host permissions are
already `https://*/*`, so no new host grant and no new install-time warning
beyond the scripting one.

Injection uses `chrome.scripting.executeScript` on demand from the popup, rather
than a `content_scripts` block that runs on every page load. The picker is a
deliberate, rare action; injecting it into every page the user visits would be a
much larger privacy and performance footprint for no benefit.

New files: `extension/picker.js` (the injected overlay) and a small bundled copy
of the shared selector/price-parsing helpers.

## Work breakdown

1. Migration `002_price_selector.ts` + regenerate `src/lib/db/types.ts`.
2. `deriveSelector.ts` + unit tests.
3. `parse.ts`: `priceSelector` option, user-selector stage, fall-through.
4. `types.ts`: `ExtractPriceFn` options parameter.
5. `items.service.ts`: `addItem` options, skip extraction when `observedPrice`
   is supplied, pass stored selector through `checkItem`.
6. `/api/ingest`: schema union, pass the new fields through.
7. Extension: `scripting` permission, picker overlay, popup entry point.
8. UI: surface `price_selector_failing` on the item, offer "re-pick".
9. Real-run verification with the unpacked extension.

Steps 1–6 are server-side and independently testable. Step 7 is the only part
that cannot be covered by the automated suite and needs manual browser
verification.
