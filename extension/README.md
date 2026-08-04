# Hintavahti Chrome extension

One button: capture every open http(s) tab and POST it to `/api/ingest`.

Manifest V3, service worker only. No content scripts — the server fetches and
parses each page itself, so the extension never reads page content and needs
no per-site permission. No long-running timers either: an MV3 worker is
terminated when idle, so anything on a `setInterval` would simply never fire.
Everything happens inside a message handler.

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
| `manifest.json` | MV3 manifest. `tabs` + `storage` permissions only. |
| `popup.html/.css/.js` | The one-button UI. Collects and de-duplicates tabs. |
| `service-worker.js` | Performs the request; outlives the popup. |
| `options.html/.js` | API address, shared secret, connection test. |
| `config.js` | Shared `chrome.storage.sync` access and validation. |

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
