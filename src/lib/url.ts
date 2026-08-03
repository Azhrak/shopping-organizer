/**
 * URL normalisation. The items table has a UNIQUE constraint on url, so two
 * captures of the same product must produce the same string or the same item
 * is saved twice.
 *
 * Isomorphic — safe to import from client code.
 */

/**
 * Query parameters that identify a marketing campaign rather than a product.
 * Stripping them means a link from a newsletter and the same link opened
 * directly are recognised as one item.
 */
const TRACKING_PARAMS = new Set([
	"utm_source",
	"utm_medium",
	"utm_campaign",
	"utm_term",
	"utm_content",
	"utm_id",
	"gclid",
	"fbclid",
	"msclkid",
	"mc_cid",
	"mc_eid",
	"igshid",
	"ref",
	"ref_src",
	"_gl",
]);

export interface NormalisedUrl {
	url: string;
	hostname: string;
}

/**
 * Normalise a product URL for storage.
 *
 * - Rejects anything that is not http(s), so javascript: and data: URLs and
 *   chrome:// tabs from the extension never reach the extractor.
 * - Lowercases the hostname and strips a leading "www.".
 * - Drops tracking parameters and the fragment.
 * - Sorts the remaining query parameters so ordering does not create
 *   duplicate items.
 *
 * Returns null when the input is not a usable http(s) URL.
 */
export function normaliseUrl(input: string): NormalisedUrl | null {
	let parsed: URL;

	try {
		parsed = new URL(input.trim());
	} catch {
		return null;
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return null;
	}

	if (parsed.hostname === "") {
		return null;
	}

	parsed.hostname = parsed.hostname.toLowerCase();
	if (parsed.hostname.startsWith("www.")) {
		parsed.hostname = parsed.hostname.slice(4);
	}

	parsed.hash = "";

	for (const key of [...parsed.searchParams.keys()]) {
		if (TRACKING_PARAMS.has(key.toLowerCase())) {
			parsed.searchParams.delete(key);
		}
	}
	parsed.searchParams.sort();

	// Drop a trailing "?" left behind when every parameter was stripped.
	let url = parsed.toString();
	if (url.endsWith("?")) {
		url = url.slice(0, -1);
	}

	return { url, hostname: parsed.hostname };
}
