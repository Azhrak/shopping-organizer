# Design: checking prices through the user's own browser

Status: **proposed, not implemented**. Written for review before any code.

Companion to [price-picker.md](price-picker.md). The two features are
independent but strongly complementary — see "Why this needs the picker".

## Problem

Two tracked stores cannot be checked server-side, for two different reasons.
Both were verified by probing them directly rather than assumed:

| Store | Server-side result | Actual cause |
|---|---|---|
| gigantti.fi | HTTP 429, 31 kB body | Vercel Security Checkpoint — an active anti-bot challenge |
| power.fi | HTTP 200, 90 kB body | Angular SPA — empty shell, zero `<a href>`, zero JSON-LD |

Neither is solvable by a better server-side fetch. Gigantti deliberately blocks
non-browser clients; Power's price does not exist until JavaScript runs.

An earlier note in this project claimed both were bot-blocking. That was wrong:
only Gigantti challenges. Power serves 200 to anything and simply has no content
in the HTML.

### Why not headless Playwright

Considered and rejected for now:

- Against **Gigantti** it likely fails anyway — headless browsers are themselves
  detectable, and getting through would mean stealth plugins, fingerprint
  spoofing and residential proxies. That is deliberately defeating a protection
  the store chose to deploy, and is not something this project should do.
- Against **Power** it would work, but costs ~300 MB of browser binaries, system
  libraries wherever cron runs, and seconds plus hundreds of MB of RAM per
  render — versus milliseconds for `fetch`.

The user's own browser beats it on every axis: a real session with real cookies
passes Gigantti's checkpoint without evasion, and real JavaScript execution
solves Power. No new server dependency at all.

## Scope (decided)

- The check loop runs in a **dedicated extension page** — a real tab, not the
  popup.
- A run covers **only items the server cannot handle**: those flagged as
  requiring a browser, plus those currently failing extraction.

Server-side cron remains the default path for everything that works today.
This feature is a complement to it, never a replacement.

## Why this needs the picker

There is no browser event meaning "the price has rendered". `tab.status ===
"complete"` fires when the DOM is ready, which on an SPA is routinely *before*
the price exists. So the loop has to wait for something, and the only
well-defined wait condition is **a selector the user pointed at**.

Without a stored selector, an empty read is ambiguous: not loaded yet, or no
price on this page? The two are indistinguishable, and guessing wrong either
records nothing or waits forever.

Therefore: an item is eligible for browser-checking **only if it has a
`price_selector`**. The picker is what makes this feature well-defined, and
should land first.

## Flow

```
user opens the check page and presses "Check prices"
        │
        ├─ GET /api/due?mode=browser
        │     → [{ itemId, url, priceSelector }]
        │
        ├─ for each item, SEQUENTIALLY:
        │     chrome.tabs.create({ url, active: false })
        │     await tab load
        │     poll: executeScript reading priceSelector,
        │           every 500 ms up to 15 s
        │     chrome.tabs.remove(tabId)          ← always, even on failure
        │
        └─ POST /api/observations
              → [{ itemId, price, currency, availability }]
                 server records price_checks rows via the service layer
```

Sequential, never parallel. Thirty tabs at once would wedge the browser and
look indistinguishable from abuse to the stores involved.

## Server changes

### New column

Migration adds to `items`:

```ts
.addColumn("check_via_browser", "boolean", (col) =>
  col.notNull().defaultTo(false))
```

Set when an item's server-side extraction is hopeless — either the user marks
it, or `checkItem` detects a persistent 429/empty-shell signature. Defaults to
false, so every existing row keeps its current behaviour.

### New route: `GET /api/due`

Returns the work list for a browser run. Same shared-secret auth as the existing
external routes (`x-hintavahti-secret`), same CSRF exemption by virtue of being
a server route rather than a server function.

```ts
// mode=browser: items needing a real browser, that CAN be browser-checked
// (i.e. have a stored selector), oldest-due first.
{ items: [{ itemId, url, priceSelector, title }] }
```

Query is the existing `findDueItems` predicate plus
`check_via_browser = true AND price_selector IS NOT NULL`. Capped at a
configurable limit (default 50) so a run is always bounded.

### New route: `POST /api/observations`

Accepts prices the browser observed:

```ts
z.object({
  observations: z.array(z.object({
    itemId: z.string().uuid(),
    price: z.number().positive().finite(),      // MAJOR units
    currency: z.string().length(3).optional(),
    availability: z.enum(["in_stock","out_of_stock","unknown"]).optional(),
    error: z.string().max(300).optional(),      // set instead of price on failure
  })).min(1).max(200),
})
```

Units: **MAJOR units on the wire**, matching `PriceResult.price` and the
extractor contract. `toMinorUnits()` converts at the same boundary in the
service layer that it already does. No new conversion site; nothing in the
database or the pricing maths changes.

### Service layer

A new `recordObservation(deps, itemId, observation)` in `items.service.ts`,
sitting beside `checkItem` and sharing its write path:

- success → insert a `price_checks` row, reset `consecutive_failures` to 0,
  clear `extract_failing`, advance `next_check_at`;
- failure → **no `price_checks` row**, increment `consecutive_failures`, set
  `extract_failing`, apply the same exponential backoff.

That second rule is load-bearing and matches the existing invariant:
`price_checks` is a pure record of observed prices so no stats query has to
average over nulls or sentinels. A browser-observed failure is recorded on the
item exactly like a server-side one.

`recordObservation` takes no extractor and performs no fetch — the price is
supplied. It still lives in the service layer so the same drop-alert and
backoff logic applies, rather than being reimplemented in a route.

## Extension changes

### Manifest

```json
"permissions": ["tabs", "storage", "scripting"]
```

`scripting` is the only addition; `https://*/*` host permission already exists.
Shared with the picker feature, which needs the same grant.

### Why a dedicated page, not the popup or the worker

The existing service worker's docblock states the constraint plainly:

> Strictly event-driven: no setInterval, no setTimeout, no alarms. An MV3
> worker is terminated when idle, so a long-running timer would simply never
> fire.

That is correct and directly rules the worker out as the driver: a sequential
run over dozens of items takes minutes and involves waiting, which is exactly
what an MV3 worker cannot do reliably. Rewriting it around `chrome.alarms` and
persisted progress would contradict its stated design and be materially harder
to get right.

The popup is also unusable: it closes the moment focus moves, which happens as
soon as a background tab loads.

So the loop runs in `check.html` — a normal extension page in a real tab, with a
normal event loop that lives as long as the tab is open. It shows live progress
and offers cancel.

The service worker keeps its current role: it performs the authenticated
`fetch` calls to the server on the page's behalf, unchanged in character.

### New files

- `extension/check.html` / `check.js` — the run page and its loop.
- `extension/readPrice.js` — the injected function that reads a selector and
  returns its text. Deliberately tiny and side-effect free; it reads the DOM
  and returns a string, nothing else.

### Waiting rule

Per item: wait for `tab.status === "complete"`, then poll `readPrice` every
500 ms up to a 15 s ceiling. First poll returning text that parses as a price
wins. On timeout, record a failure for that item and move on.

Background-tab throttling is a known risk here — Chrome deprioritises timers and
rendering in non-active tabs, so a slow SPA may need most of that budget. The
ceiling is configurable for exactly that reason.

## Safety and abuse

Anything that opens tabs automatically deserves hard limits:

- **Sequential only.** One tab at a time, closed before the next opens.
- **Bounded run.** Server caps the work list; the page caps it again.
- **Always clean up.** `chrome.tabs.remove` in a `finally`, so a crashed item
  never leaks a tab.
- **Visible and cancellable.** Live progress, working cancel button.
- **User-initiated only.** No alarms, no background scheduling. It runs because
  someone pressed a button and is watching.
- **Per-host pacing.** Reuse the existing `createHostGate` idea — a short delay
  between consecutive hits on the same hostname, so a run never looks like a
  burst to one store.

Observed prices are client-supplied, and in a single-user self-hosted app the
client is the user, so this is not a privilege boundary. Values are still
validated (finite, positive, sane ceiling) so a mis-parse cannot write a
nonsense price that stats then average over.

## Testing plan

Unit:

- `recordObservation` success/failure state transitions, backoff maths.
- Price-string parsing reuses `parsePriceString`, already covered.

Integration (real Postgres):

- Observation writes exactly one `price_checks` row at the right minor value.
- Failed observation writes **no** `price_checks` row, increments
  `consecutive_failures`, sets `extract_failing`.
- `GET /api/due?mode=browser` returns only items with
  `check_via_browser = true AND price_selector IS NOT NULL`.
- Drop-alert dedupe behaves identically whether the price came from the server
  or the browser.

Manual (cannot be automated — needs a real browser):

- Load unpacked, pick a price on power.fi, run a check, confirm the value
  matches the page and is stored in minor units with Finnish formatting.
- Same against gigantti.fi, confirming the real session passes the checkpoint
  that the server-side fetch cannot.
- Cancel mid-run leaves no orphaned tabs.

## Limitations — stated plainly

- **Only runs when the user presses the button.** Not a scheduler. Items
  checked this way will go stale between runs, and the UI should show when an
  item was last browser-checked rather than implying it is monitored.
- **Requires a picked selector.** No selector, no browser check.
- **Visible and interruptible.** Tabs appear in the tab strip; closing the
  window ends the run.
- **Background throttling can slow SPA rendering**, so the timeout is a real
  tradeoff, not a formality.
- **Stores can still break it.** A redesign invalidates the selector; the item
  fails and the user re-picks.
- **This is not a way around Gigantti's protection.** It works because a real
  person is using a real browser session they already have. It must stay
  user-initiated and visible for that to remain true — which is the reason for
  the abuse limits above, not merely politeness.

## Work breakdown

1. Migration: `check_via_browser` (+ `price_selector` from the picker design).
2. `recordObservation` in `items.service.ts` + unit/integration tests.
3. `GET /api/due` route + tests.
4. `POST /api/observations` route + tests.
5. Extension: `scripting` permission, `check.html`/`check.js`, `readPrice.js`.
6. UI: show "checked via browser" and last-checked time on the item.
7. Manual verification against power.fi and gigantti.fi.

Steps 1–4 are server-side and fully covered by the automated suite. Step 5 is
the only part requiring manual browser verification.

## Open question for review

Should `check_via_browser` be set **manually** by the user, or **automatically**
when `checkItem` sees a persistent block signature (repeated 429, or a 200 whose
body yields no price and no links)? Automatic is friendlier but risks
mis-flagging a temporarily broken page as permanently browser-only. My
suggestion: automatic *detection* that only ever **suggests** the flag in the
UI, with the user confirming — no silent switch of how an item is checked.
