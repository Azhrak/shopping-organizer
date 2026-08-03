import "@tanstack/react-start/server-only";

import type { PriceResult } from "./types";

/**
 * PLACEHOLDER — replace this entire file with your extractPrice module.
 *
 * This is not an implementation and deliberately does not pretend to be one:
 * it throws rather than returning a plausible-looking fake price, so nothing
 * can silently record invented data if the real module is never dropped in.
 *
 * The real module must export:
 *
 *   export async function extractPrice(url: string): Promise<PriceResult>
 *
 * with the cascade JSON-LD -> microdata -> OG meta -> per-site CSS selectors,
 * returning ok:false on failure rather than guessing.
 *
 * The `server-only` import above keeps this file (and cheerio, and outbound
 * fetch) out of every client bundle — Start's import protection fails the
 * build if client code ever reaches it. Keep that import when you replace
 * the file.
 *
 * Note on units: the service layer treats PriceResult.price as MAJOR units
 * (1299.00 EUR) and converts to integer minor units via toMinorUnits() before
 * anything is stored. If your module already returns cents, change the call
 * site in src/lib/services/items.service.ts rather than the database.
 */
export async function extractPrice(url: string): Promise<PriceResult> {
	throw new Error(
		`extractPrice is not installed. Replace src/lib/extraction/extractPrice.server.ts ` +
			`with the real module before tracking prices. Requested URL: ${url}`,
	);
}
