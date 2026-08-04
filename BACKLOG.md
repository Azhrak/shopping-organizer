# Backlog

What is done, what is not, and what to pick up next. Update this in the same
commit as the work it describes.

Design documents live in [design/](design/); this file tracks their status, it
does not duplicate their content.

---

## Pick up here

**The price picker has never been loaded in a browser.** Everything server-side
is built and verified; the extension is written but unproven. That manual pass
is the next thing worth doing, and it blocks the browser-checking feature
behind it.

1. `chrome://extensions` → Developer mode → **Load unpacked** → `extension/`.
2. Copy the extension origin from its Settings page into `EXTENSION_ORIGIN` in
   `.env` — the id changes every time it is removed and re-added — and restart
   the server.
3. Open a product page, click **Point at the price**, pick the price.
4. Confirm the item appears with the right value and Finnish formatting.

Try Gigantti first. It returns 429 to every server-side fetch, so it is the
case the picker exists for, and a success there proves the whole path.

What could plausibly break, none of it covered by the test suite: injection
itself, the overlay rendering, `chrome.runtime.getURL` module loading, the
badge, and `deriveSelector` against a DOM nobody has tested it on.

---

## Done

| Area | State |
| --- | --- |
| Schema + migrations | Kysely, `001_initial` + `002_price_selector` |
| Service layer | `addItem`, `checkItem`, `checkAllDue`, pure pricing maths |
| Server functions + routes | UI server fns, `/api/ingest`, `/api/cron/check` |
| Scheduled checks | `scripts/check-due.ts` |
| UI | Imported Claude Design, dark default + `[data-theme="light"]` |
| Chrome extension (capture) | MV3, bulk "grab open tabs" |
| **Price extractor** | Real implementation — JSON-LD → microdata → meta → selectors |
| **Picker (server side)** | `price_selector`, `deriveSelector`, observed prices |
| **Picker (extension)** | Overlay written — **not yet run in a browser** |
| Stale-pick indicator | `priceSelectorFailing` on card + detail page |
| Build | `pnpm build` works without a `NODE_ENV` prefix |
| Line endings | Pinned to LF via `.gitattributes` |

Verification, re-run on 2026-08-04: **204 unit**, **98 integration**, `tsc`
clean, `pnpm lint` exits 0, production build succeeds, and
`pnpm build:extension` leaves the checked-in generated copy unchanged. The
stale-pick indicator was also checked against a booted server with a seeded
failing item: both the card badge and the detail banner render, and a healthy
item shows neither. The U+00A0 separator check is older and was not repeated.

---

## Next up

### 1. Verify the picker in a browser
See **Pick up here**. Still the next thing: browser checking depends on the
picker working, the hardcoded selectors below are best replaced by picked ones
rather than guessed harder, and the re-pick trigger in item 3 cannot be built
until there is a picker known to work.

### 2. Browser checking
Design: [design/browser-checking.md](design/browser-checking.md). Not started —
`check_via_browser` does not exist in the schema yet.

Runs checks through the user's own browser for stores the server cannot read.
Decided scope: a dedicated extension page drives the loop, covering only items
the server cannot handle.

Work breakdown is in the design. Steps 1–4 are server-side and fully testable;
step 5 needs a real browser.

**Depends on the picker**, and not incidentally: there is no event meaning "the
price has rendered", so the only well-defined thing to wait for is a selector
the user picked. Without one, an empty read cannot be distinguished from a slow
one.

### 3. Offer a re-pick when `price_selector_failing` is set
The **indicator half is done**: `priceSelectorFailing` is carried on both
`ItemListEntry` and `ItemDetail`, the card shows a "Picked price no longer
found" badge, and the detail page explains that tracking continues via the
generic cascade and names the dead selector.

What is left is the re-pick trigger, and it is blocked on the browser pass
above. A selector can only reach the server through `/api/ingest` from the
extension — there is no server function that updates `price_selector` on an
existing item — so any affordance has to drive a picker nobody has run yet.

A cheaper intermediate, if the re-pick stays blocked: extend `updateItemFn` to
*clear* a stale selector, which needs no extension work.

---

## Known problems

### Hardcoded selectors for Gigantti and Power are guesses
`SITE_SELECTORS` in [src/lib/extraction/parse.ts](src/lib/extraction/parse.ts)
carries entries for `gigantti.fi` and `power.fi` that have **never been checked
against those sites' real DOM**, because neither page can be fetched
server-side. They are unverifiable by construction.

Nothing depends on them today — the structured stages carry the pages that do
work — but they should be deleted or replaced with user-picked selectors rather
than left as if they were tested. Only `verkkokauppa.com` is verified.

### `deriveSelector` will use hashed classes in ancestor paths
It refuses a hashed class as the *anchor*, but a structural path may still be
prefixed by one (observed on Verkkokauppa:
`.sc-w0pf0h-0 > div:nth-of-type(1) > button:nth-of-type(1)`). Permitted by the
rules as written, and every such selector still validated, but it is a
durability weakness: those prefixes change on the store's next deploy.

Worth revisiting only if picked selectors turn out to break often in practice.

### An observed price is trusted without verification
`addItem` skips extraction entirely when `observedPrice` is supplied. That is
deliberate — the whole point on a store the server cannot reach — but it means
the recorded price is only as good as the extension's parse of the element
text. Validated for range and finiteness, not for truth.

---

## Not doing

**Headless Playwright.** Rejected after measuring both stores rather than
assuming: Gigantti returns 429 behind a Vercel challenge, Power returns 200 as
an Angular SPA with an empty shell. Against Gigantti, getting through would
mean stealth plugins and fingerprint spoofing — deliberately defeating a
protection the store chose to deploy. Against Power it would work, but costs
~300 MB of browser binaries and seconds per render for something the user's own
browser already does. Reasoning is in
[design/browser-checking.md](design/browser-checking.md).

---

## Housekeeping

- `HEAD` is 4 commits ahead of `origin/main`, starting at `6a1f0aa` (Biome).
  Nothing has been pushed yet.
- Do not install Biome globally. It is pinned as a devDependency at 2.5.7 and
  `pnpm lint` uses that copy; a global one at a different version fights it.
- `extension/shared.generated.js` is generated. Edit the TypeScript sources and
  run `pnpm build:extension` — a test fails if the checked-in copy goes stale.
