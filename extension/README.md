# Hintavahti Chrome extension

One button: capture every open http(s) tab and POST it to `/api/ingest`.

Manifest V3, service worker plus an on-demand price picker. No long-running
timers: an MV3 worker is terminated when idle, so anything on a `setInterval`
would simply never fire. Everything happens inside a message handler.

There are no declared content scripts. The picker is injected only when the
user clicks **Point at the price**, so nothing runs on pages they are merely
visiting.

## Point at the price

For stores the server cannot read — Gigantti challenges non-browser clients,
Power renders its prices with JavaScript — the server-side fetch will never see
a price. The picker solves that by reading the page the user's own browser has
already rendered:

1. Open the product page, click the extension, then **Point at the price**.
2. Hover: the element under the cursor is outlined and the price that would be
   captured is previewed.
3. Click to confirm. Escape or right-click cancels.

The extension derives a CSS selector, **validates that it still matches exactly
that element**, and posts it with the observed price. The selector is stored on
the item and used by every later server-side check; the observed price is
recorded immediately, so an item on a blocked store is never left empty.

If no stable selector can be derived, the extension says so rather than storing
a fragile one — the same refuse-over-guess rule the extractor follows.

A price split across nodes (`<data value="11.99">11<small>,99</small></data>`,
which is what Verkkokauppa emits) is handled: clicking the cents captures the
whole price, not `,99`.

## Install (unpacked)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this `extension/` directory.
3. Open the extension's **Settings** (link at the bottom of the popup).
4. Copy the **This extension's origin** value shown there.
5. On the server, set it in `.env` and restart:

   ```sh
   EXTENSION_ORIGIN=chrome-extension://<the id from step 4>
   INGEST_SECRET=<a strong random value>
   ```

   ```sh
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

6. Back in Settings, enter the API address and the same secret, **Save**, then
   **Test connection**.

The extension id changes if you remove and re-add the unpacked extension, so
`EXTENSION_ORIGIN` needs updating if you do. Packing it, or pinning the id
with a `key` in the manifest, avoids that.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest. `tabs`, `storage`, `scripting`. |
| `popup.html/.css/.js` | The two-button UI. Collects and de-duplicates tabs. |
| `service-worker.js` | Performs requests and drives the pick; outlives the popup. |
| `picker-entry.js` | Injected bootstrap — loads `picker.js` as a module. |
| `picker.js` | The hover/click overlay. Derives and validates the selector. |
| `shared.generated.js` | **Generated.** Do not edit; run `pnpm build:extension`. |
| `options.html/.js` | API address, shared secret, connection test. |
| `config.js` | Shared `chrome.storage.sync` access and validation. |

`shared.generated.js` is produced from `src/lib/extraction/deriveSelector.ts`
and `parsePriceString` in `src/lib/extraction/parse.ts`. Chrome loads this
directory unpacked with no build step, so the code cannot be imported from
`src/` — it is transpiled and copied instead. A test fails if the copy is
stale, because a picker and a server that disagree about a selector or a parsed
price would silently record the wrong number.

The popup hands URLs to the service worker rather than fetching directly: a
popup closes the instant focus moves, which would abort its own request
mid-import. The worker survives that.

## Behaviour

- `chrome.tabs.query({})` spans every window; non-http(s) tabs (`chrome://`,
  `about:`, `file:`, other extensions) are filtered out before sending.
- Duplicate URLs are collapsed in the popup, and again server-side.
- Import is per-URL: one unreachable store does not abandon the batch. The
  popup reports `saved · already tracked · failed` and lists the failures.
- A URL whose price cannot be extracted is still **saved**, flagged as not
  tracking. A saved-but-untracked item can be fixed later; a silently dropped
  URL cannot.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| "does not allow this extension" | `EXTENSION_ORIGIN` does not match; copy the origin from Settings and restart the server. |
| "rejected the shared secret" | `INGEST_SECRET` differs between server and extension. |
| "no INGEST_SECRET configured" | Server still has the `change-me` placeholder. |
| "could not reach the server" | Wrong address, or the server is not running. |

Worker logs: `chrome://extensions` → **service worker** under this extension.
