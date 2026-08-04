/**
 * Pure HTML -> PriceResult parsing. No network, no server-only imports.
 *
 * This is deliberately separate from extractPrice.server.ts so the cascade can
 * be unit-tested against fixture HTML without touching the network. The server
 * module owns fetching; this module owns interpretation.
 *
 * Cascade order, most to least trustworthy:
 *
 *   1. JSON-LD   (schema.org Product/Offer — structured, explicitly typed)
 *   2. microdata (itemprop attributes — structured but easier to get wrong)
 *   3. OG meta   (og:price / product: meta tags — no currency guarantees)
 *   4. selector  (per-site CSS, last resort, only for hosts we have configured)
 *
 * Every stage returns null rather than a guess. A price that cannot be parsed
 * unambiguously is a failure, not an approximation: a wrong price is worse
 * than no price, because the app records it as fact and alerts on it.
 */

import * as cheerio from "cheerio";
import type { Availability, ExtractMethod, PriceResult } from "./types";

/**
 * What a single cascade stage can produce. Kept looser than PriceResult
 * because a stage may find a title but no price, and the caller merges
 * across stages.
 */
interface StageResult {
	price: number | null;
	currency: string | null;
	title: string | null;
	image: string | null;
	availability: Availability;
}

const EMPTY_STAGE: StageResult = {
	price: null,
	currency: null,
	title: null,
	image: null,
	availability: "unknown",
};

/**
 * Per-host CSS selectors, used only when the structured stages all fail.
 *
 * Hostnames are matched after stripping a leading "www.". A host absent from
 * this map simply has no selector stage — it is not an error, and no generic
 * "find something that looks like a price" fallback exists, because on a real
 * store page that reliably finds the wrong number (a strike-through original,
 * a monthly financing figure, a shipping threshold, an unrelated upsell).
 */
const SITE_SELECTORS: Record<
	string,
	{ price: string; currency?: string; title?: string; image?: string }
> = {
	"verkkokauppa.com": {
		price: '[data-test-id="product-price"]',
		title: "h1",
	},
	"gigantti.fi": {
		price: ".product-price .price",
		title: "h1",
	},
	"power.fi": {
		price: ".product-price-container .price",
		title: "h1",
	},
};

/** Availability strings schema.org uses, mapped onto our three states. */
function normaliseAvailability(raw: string | null | undefined): Availability {
	if (!raw) {
		return "unknown";
	}

	// Values appear as both bare tokens ("InStock") and full URLs
	// ("https://schema.org/InStock"), in any case.
	const token = raw.trim().toLowerCase().split("/").pop() ?? "";

	switch (token) {
		case "instock":
		case "in_stock":
		case "instoreonly":
		case "onlineonly":
		case "limitedavailability":
		case "presale":
			return "in_stock";
		case "outofstock":
		case "out_of_stock":
		case "soldout":
		case "discontinued":
		case "backorder":
			return "out_of_stock";
		default:
			return "unknown";
	}
}

/**
 * Parse a price string into a MAJOR-unit number, or null if it is ambiguous.
 *
 * The hard case is separators: "1.299,00" (European) and "1,299.00" (US) mean
 * the same amount, while "1.299" alone could be either 1299 or 1.299. Rules:
 *
 *   - If both separators appear, the LAST one is the decimal separator.
 *   - If one appears once with exactly 2 digits after it, it is a decimal.
 *   - If one appears with exactly 3 digits after it, it is a thousands group.
 *   - Anything else with a lone separator is ambiguous -> null.
 *
 * "1.299" therefore returns null rather than picking a reading, which is the
 * whole point: guessing here is a 1000x error.
 */
export function parsePriceString(raw: string | number | null): number | null {
	if (raw === null || raw === undefined) {
		return null;
	}

	// JSON-LD often carries a real number already. Trust it as-is: there are no
	// separators to misread.
	if (typeof raw === "number") {
		return Number.isFinite(raw) && raw >= 0 ? raw : null;
	}

	// Strip currency symbols, letters, and whitespace (including the NBSP and
	// narrow-NBSP that Finnish formatting uses), keeping only digits and
	// separators.
	const cleaned = raw.replace(/[^\d.,-]/g, "").trim();

	if (cleaned === "" || cleaned === "-") {
		return null;
	}

	// A negative price is never valid for a product.
	if (cleaned.startsWith("-")) {
		return null;
	}

	const lastDot = cleaned.lastIndexOf(".");
	const lastComma = cleaned.lastIndexOf(",");

	let normalised: string;

	if (lastDot !== -1 && lastComma !== -1) {
		// Both present: the rightmost is the decimal separator, the other groups.
		const decimalSep = lastDot > lastComma ? "." : ",";
		const groupSep = decimalSep === "." ? "," : ".";
		normalised = cleaned.split(groupSep).join("").replace(decimalSep, ".");
	} else if (lastDot === -1 && lastComma === -1) {
		normalised = cleaned;
	} else {
		const sep = lastDot !== -1 ? "." : ",";
		const parts = cleaned.split(sep);

		// More than one separator of the same kind means grouping: 1.234.567
		if (parts.length > 2) {
			// Every group after the first must be exactly 3 digits, or this is
			// not a grouped number and we cannot read it.
			const groupsValid = parts.slice(1).every((part) => /^\d{3}$/.test(part));
			if (!groupsValid) {
				return null;
			}
			normalised = parts.join("");
		} else {
			const tail = parts[1] ?? "";
			if (/^\d{2}$/.test(tail)) {
				// 12,34 / 12.34 -> decimal
				normalised = `${parts[0]}.${tail}`;
			} else if (/^\d{3}$/.test(tail)) {
				// 1.299 / 1,299 -> ambiguous in principle, but a 3-digit tail is
				// overwhelmingly a thousands group and never a valid 3-decimal
				// price in EUR retail. Treat as grouping.
				normalised = `${parts[0]}${tail}`;
			} else if (/^\d{1}$/.test(tail)) {
				// 12,5 -> one decimal place
				normalised = `${parts[0]}.${tail}`;
			} else {
				return null;
			}
		}
	}

	if (!/^\d+(\.\d+)?$/.test(normalised)) {
		return null;
	}

	const value = Number(normalised);

	if (!Number.isFinite(value) || value <= 0) {
		return null;
	}

	return value;
}

/** Currency codes we accept. Anything else is passed through uppercased. */
function normaliseCurrency(raw: string | null | undefined): string | null {
	if (!raw) {
		return null;
	}

	const trimmed = raw.trim();

	// Symbols appear where a code is expected often enough to be worth mapping.
	const symbols: Record<string, string> = {
		"€": "EUR",
		$: "USD",
		"£": "GBP",
		kr: "SEK",
	};

	if (symbols[trimmed]) {
		return symbols[trimmed];
	}

	if (/^[A-Za-z]{3}$/.test(trimmed)) {
		return trimmed.toUpperCase();
	}

	return null;
}

/** Walk an arbitrarily nested JSON-LD value, yielding every object node. */
function* walkJsonLd(node: unknown): Generator<Record<string, unknown>> {
	if (Array.isArray(node)) {
		for (const child of node) {
			yield* walkJsonLd(child);
		}
		return;
	}

	if (node !== null && typeof node === "object") {
		const obj = node as Record<string, unknown>;
		yield obj;

		// @graph and nested offers/items are where Product nodes usually hide.
		for (const value of Object.values(obj)) {
			if (value !== null && typeof value === "object") {
				yield* walkJsonLd(value);
			}
		}
	}
}

function hasType(node: Record<string, unknown>, type: string): boolean {
	const raw = node["@type"];
	if (typeof raw === "string") {
		return raw.toLowerCase() === type.toLowerCase();
	}
	if (Array.isArray(raw)) {
		return raw.some(
			(entry) =>
				typeof entry === "string" && entry.toLowerCase() === type.toLowerCase(),
		);
	}
	return false;
}

function firstString(value: unknown): string | null {
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number") {
		return String(value);
	}
	if (Array.isArray(value)) {
		for (const entry of value) {
			const found = firstString(entry);
			if (found !== null) {
				return found;
			}
		}
	}
	// schema.org allows { "@type": "ImageObject", "url": "..." }
	if (value !== null && typeof value === "object") {
		const url = (value as Record<string, unknown>).url;
		if (typeof url === "string") {
			return url;
		}
	}
	return null;
}

/**
 * Stage 1: schema.org JSON-LD.
 *
 * Looks for a Product node and reads its Offer. Where several offers exist
 * (size/colour variants), the LOWEST price wins — that matches what the store
 * advertises as "from X" and is the number a shopper is watching.
 */
export function fromJsonLd($: cheerio.CheerioAPI): StageResult {
	const scripts = $('script[type="application/ld+json"]').toArray();

	let best: StageResult | null = null;

	for (const script of scripts) {
		const text = $(script).text().trim();
		if (!text) {
			continue;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			// A malformed block is skipped, not fatal: pages often carry several
			// and only one needs to be readable.
			continue;
		}

		for (const node of walkJsonLd(parsed)) {
			if (!hasType(node, "Product")) {
				continue;
			}

			const title = firstString(node.name);
			const image = firstString(node.image);

			// Offers may be a single object, an array, or an AggregateOffer.
			const offerNodes: Array<Record<string, unknown>> = [];
			for (const candidate of walkJsonLd(node.offers)) {
				if (
					hasType(candidate, "Offer") ||
					hasType(candidate, "AggregateOffer") ||
					"price" in candidate ||
					"lowPrice" in candidate
				) {
					offerNodes.push(candidate);
				}
			}

			for (const offer of offerNodes) {
				// AggregateOffer uses lowPrice; a plain Offer uses price.
				const rawPrice =
					offer.price ?? offer.lowPrice ?? offer.priceSpecification;

				let priceValue: number | null = null;
				if (
					rawPrice !== null &&
					typeof rawPrice === "object" &&
					!Array.isArray(rawPrice)
				) {
					// PriceSpecification wrapper
					priceValue = parsePriceString(
						firstString((rawPrice as Record<string, unknown>).price),
					);
				} else {
					priceValue = parsePriceString(firstString(rawPrice));
				}

				if (priceValue === null) {
					continue;
				}

				const currency = normaliseCurrency(
					firstString(offer.priceCurrency) ?? firstString(node.priceCurrency),
				);
				const availability = normaliseAvailability(
					firstString(offer.availability),
				);

				const candidate: StageResult = {
					price: priceValue,
					currency,
					title,
					image,
					availability,
				};

				if (
					best === null ||
					priceValue < (best.price ?? Number.POSITIVE_INFINITY)
				) {
					best = candidate;
				}
			}

			// A Product with no readable offer still supplies title, image and
			// availability, which are worth merging even though the stage did not
			// produce a price. Dropping availability here would lose a stated
			// out-of-stock on any page whose price comes from a weaker stage.
			if (best === null) {
				const availability = offerNodes
					.map((offer) =>
						normaliseAvailability(firstString(offer.availability)),
					)
					.find((value) => value !== "unknown");

				if (title || image || availability) {
					best = {
						...EMPTY_STAGE,
						title,
						image,
						availability: availability ?? "unknown",
					};
				}
			}
		}
	}

	return best ?? EMPTY_STAGE;
}

/**
 * Stage 2: microdata (itemprop attributes).
 *
 * A price can live in `content` (machine-readable, preferred) or in the
 * element text. `content` is tried first because the text is localised and
 * often decorated.
 */
export function fromMicrodata($: cheerio.CheerioAPI): StageResult {
	function readProp(prop: string): string | null {
		const el = $(`[itemprop="${prop}"]`).first();
		if (el.length === 0) {
			return null;
		}
		const content = el.attr("content");
		if (content !== undefined && content.trim() !== "") {
			return content;
		}
		// <link itemprop="availability" href="https://schema.org/InStock">
		const href = el.attr("href");
		if (href !== undefined && href.trim() !== "") {
			return href;
		}
		const src = el.attr("src");
		if (src !== undefined && src.trim() !== "") {
			return src;
		}
		const text = el.text().trim();
		return text === "" ? null : text;
	}

	const price = parsePriceString(readProp("price"));
	const currency = normaliseCurrency(readProp("priceCurrency"));
	const title = readProp("name");
	const image = readProp("image");
	const availability = normaliseAvailability(readProp("availability"));

	return { price, currency, title, image, availability };
}

/**
 * Stage 3: OpenGraph / product meta tags.
 *
 * Weaker than the structured stages — og:price:amount has no schema behind it
 * and stores populate it inconsistently — but it is common and machine-
 * readable, so it beats scraping visible text.
 */
export function fromMeta($: cheerio.CheerioAPI): StageResult {
	function meta(...names: Array<string>): string | null {
		for (const name of names) {
			const byProperty = $(`meta[property="${name}"]`).attr("content");
			if (byProperty !== undefined && byProperty.trim() !== "") {
				return byProperty;
			}
			const byName = $(`meta[name="${name}"]`).attr("content");
			if (byName !== undefined && byName.trim() !== "") {
				return byName;
			}
		}
		return null;
	}

	const price = parsePriceString(
		meta("og:price:amount", "product:price:amount", "product:price"),
	);
	const currency = normaliseCurrency(
		meta("og:price:currency", "product:price:currency"),
	);
	const title = meta("og:title", "twitter:title");
	const image = meta("og:image", "twitter:image");
	const availability = normaliseAvailability(
		meta("og:availability", "product:availability"),
	);

	return { price, currency, title, image, availability };
}

/**
 * Stage 4: per-host CSS selectors. Only runs for hosts in SITE_SELECTORS.
 */
export function fromSelectors(
	$: cheerio.CheerioAPI,
	hostname: string,
): StageResult {
	const host = hostname.replace(/^www\./, "").toLowerCase();
	const config = SITE_SELECTORS[host];

	if (!config) {
		return EMPTY_STAGE;
	}

	function readSelector(selector: string | undefined): string | null {
		if (!selector) {
			return null;
		}
		const el = $(selector).first();
		if (el.length === 0) {
			return null;
		}
		const content = el.attr("content");
		if (content !== undefined && content.trim() !== "") {
			return content;
		}
		const text = el.text().trim();
		return text === "" ? null : text;
	}

	const priceText = readSelector(config.price);

	return {
		price: parsePriceString(priceText),
		// A visible price string carries its own symbol; recover the currency
		// from it when the site config does not name a separate element.
		currency:
			normaliseCurrency(readSelector(config.currency)) ??
			currencyFromText(priceText),
		title: readSelector(config.title),
		image: readSelector(config.image),
		availability: "unknown",
	};
}

/** Recover a currency code from a rendered price like "1 299,00 €". */
function currencyFromText(text: string | null): string | null {
	if (!text) {
		return null;
	}
	if (text.includes("€")) {
		return "EUR";
	}
	if (text.includes("£")) {
		return "GBP";
	}
	if (text.includes("$")) {
		return "USD";
	}
	return null;
}

/** Fall back to the document title when no stage supplied a product name. */
function documentTitle($: cheerio.CheerioAPI): string | null {
	const text = $("title").first().text().trim();
	return text === "" ? null : text;
}

/**
 * Resolve a possibly-relative image URL against the page URL, so what is
 * stored can actually be rendered by the UI.
 *
 * An already-absolute URL is returned verbatim. Image CDNs put colons in path
 * segments — Verkkokauppa's thumbnailer emits
 *
 *   https://static.verkcdn.com/kuvastin/w:576/h:576/rt:fit/q:80/sh:0.5/plain/images/…
 *
 * which `new URL()` does round-trip losslessly, but normalising an absolute
 * URL buys nothing and the colon-heavy form is worth leaving untouched.
 *
 * The cases that do matter here are protocol-relative URLs and refusing a
 * non-http(s) scheme, so a data: or javascript: value never reaches the UI as
 * an image source.
 */
function absoluteImage(image: string | null, pageUrl: string): string | null {
	if (!image) {
		return null;
	}

	const trimmed = image.trim();

	if (trimmed === "") {
		return null;
	}

	if (/^https?:\/\//i.test(trimmed)) {
		return trimmed;
	}

	// Protocol-relative (//cdn.example.com/x.jpg) — inherit the page's scheme.
	if (trimmed.startsWith("//")) {
		try {
			return `${new URL(pageUrl).protocol}${trimmed}`;
		} catch {
			return null;
		}
	}

	// Genuinely relative: resolve, but reject anything that is not http(s) so a
	// data: or javascript: value never reaches the UI as an image source.
	try {
		const resolved = new URL(trimmed, pageUrl);
		if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
			return null;
		}
		return resolved.toString();
	} catch {
		return null;
	}
}

/**
 * Read a price from a selector the user pointed at with the extension.
 *
 * Kept separate from fromSelectors(), which applies the hardcoded per-host map:
 * this one is per-ITEM and supplied by the caller, so it works on stores nobody
 * has written a selector for.
 */
export function fromUserSelector(
	$: cheerio.CheerioAPI,
	selector: string,
): StageResult {
	let el: cheerio.Cheerio<never>;

	try {
		el = $(selector) as cheerio.Cheerio<never>;
	} catch {
		// A selector that is no longer valid CSS is a miss, not a crash.
		return EMPTY_STAGE;
	}

	if (el.length === 0) {
		return EMPTY_STAGE;
	}

	// Read the first match only. A selector matching several elements is
	// ambiguous, but deriveSelector already refuses to produce one, so this is
	// the defensive case rather than the expected one.
	const first = el.first();
	const content = first.attr("content");
	const text =
		content !== undefined && content.trim() !== ""
			? content
			: first.text().trim();

	const price = parsePriceString(text);

	return {
		price,
		currency: currencyFromText(text),
		title: null,
		image: null,
		availability: "unknown",
	};
}

export interface ParseOptions {
	/**
	 * A CSS selector the user pointed at for THIS item, if one is stored.
	 *
	 * Tried before the generic cascade: the user picked the number they care
	 * about, so on a page carrying both a JSON-LD base-model price and the
	 * variant they actually want, their choice wins.
	 */
	priceSelector?: string | null;
}

/**
 * Run the full cascade over one page's HTML.
 *
 * The first stage that yields a usable PRICE decides `method` and wins the
 * price/currency/availability. Title and image are merged across all stages,
 * since a page may carry a price in JSON-LD and a better image in OG meta.
 *
 * A supplied `priceSelector` runs ahead of everything else. If it no longer
 * matches, parsing FALLS THROUGH to the normal cascade rather than failing —
 * a stale selector should degrade to the generic behaviour, not turn a working
 * item into a broken one. `userSelectorFailed` reports that fall-through so the
 * caller can flag it for re-picking.
 */
export function parseProductHtml(
	html: string,
	url: string,
	options: ParseOptions = {},
): PriceResult {
	const $ = cheerio.load(html);

	let hostname: string;
	try {
		hostname = new URL(url).hostname;
	} catch {
		hostname = "";
	}

	const userStage = options.priceSelector
		? fromUserSelector($, options.priceSelector)
		: null;

	// Only a selector that was supplied AND failed to produce a price counts as
	// failing. No selector at all is not a failure.
	const userSelectorFailed =
		userStage !== null && userStage.price === null ? true : undefined;

	const stages: Array<[ExtractMethod, StageResult]> = [
		...(userStage && userStage.price !== null
			? ([["selector", userStage]] as Array<[ExtractMethod, StageResult]>)
			: []),
		["json-ld", fromJsonLd($)],
		["microdata", fromMicrodata($)],
		["meta", fromMeta($)],
		["selector", fromSelectors($, hostname)],
	];

	const winner = stages.find(([, stage]) => stage.price !== null);

	// Merge metadata across stages regardless of which one carried the price.
	const title =
		stages.map(([, s]) => s.title).find((value) => value) ??
		documentTitle($) ??
		null;
	const image = stages.map(([, s]) => s.image).find((value) => value) ?? null;

	if (!winner) {
		return {
			ok: false,
			url,
			price: null,
			currency: null,
			title,
			image: absoluteImage(image, url),
			availability: "unknown",
			method: null,
			userSelectorFailed,
			error: userSelectorFailed
				? "the stored price selector no longer matches, and no price was found in JSON-LD, microdata, meta tags or site selectors"
				: "no price found in JSON-LD, microdata, meta tags or site selectors",
		};
	}

	const [method, stage] = winner;

	// Availability may be stated by a stage other than the one with the price
	// (common: price in a selector, availability in JSON-LD). Take the first
	// stage that expressed an opinion.
	const availability =
		stage.availability !== "unknown"
			? stage.availability
			: (stages
					.map(([, s]) => s.availability)
					.find((value) => value !== "unknown") ?? "unknown");

	return {
		ok: true,
		url,
		price: stage.price,
		currency:
			stage.currency ??
			stages.map(([, s]) => s.currency).find((value) => value) ??
			null,
		title,
		image: absoluteImage(image, url),
		availability,
		method,
		userSelectorFailed,
	};
}
