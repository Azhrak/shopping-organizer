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
	/**
	 * True when a stored user selector was supplied but no longer matched, so
	 * parsing fell through to the generic cascade. Undefined when no selector
	 * was supplied — absence of a selector is not a failure.
	 *
	 * The price may still be present: a stale selector degrades to the cascade
	 * rather than failing the item, and this flag is what lets the UI ask the
	 * user to re-pick.
	 */
	userSelectorFailed?: boolean;
	error?: string;
}

export interface ExtractPriceOptions {
	/** A CSS selector the user pointed at for this item, if one is stored. */
	priceSelector?: string | null;
}

/**
 * Options are optional so every existing caller — and the test doubles in the
 * service integration suites — keeps compiling unchanged.
 */
export type ExtractPriceFn = (
	url: string,
	options?: ExtractPriceOptions,
) => Promise<PriceResult>;
