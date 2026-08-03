/**
 * Contract for the drop-in price extraction module (extractPrice.ts).
 *
 * This file declares ONLY the types. The implementation is supplied
 * separately and treated as a black box: JSON-LD -> microdata -> OG meta ->
 * per-site CSS selectors, returning ok:false rather than guessing.
 */

export type Availability = "in_stock" | "out_of_stock" | "unknown";

export type ExtractMethod = "json-ld" | "microdata" | "meta" | "selector";

export interface PriceResult {
	ok: boolean;
	url: string;
	/**
	 * Price in MAJOR units (e.g. 1299.00 EUR) as returned by the extractor.
	 * The service layer converts this to integer minor units before it ever
	 * touches the database — see toMinorUnits() in ~/lib/money.
	 */
	price: number | null;
	currency: string | null;
	title: string | null;
	image: string | null;
	availability: Availability;
	method: ExtractMethod | null;
	error?: string;
}

export type ExtractPriceFn = (url: string) => Promise<PriceResult>;
