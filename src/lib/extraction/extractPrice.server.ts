import "@tanstack/react-start/server-only";

import { parseProductHtml } from "./parse";
import type { ExtractPriceOptions, PriceResult } from "./types";

/**
 * Price extraction: fetch a product page and read its price.
 *
 * This module owns the network half only — fetching, timeouts, size limits and
 * turning transport failures into an ok:false PriceResult. All interpretation
 * of the HTML lives in ./parse, which is pure and unit-tested against fixtures.
 *
 * The `server-only` import above keeps this file (and cheerio, and outbound
 * fetch) out of every client bundle — Start's import protection fails the build
 * if client code ever reaches it. Do not remove it.
 *
 * Units: the returned PriceResult.price is in MAJOR units (1299.00 EUR). The
 * service layer converts to integer minor units via toMinorUnits() before
 * anything is stored.
 */

/** Give up on a page that has not responded in this long. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Stop reading after this many bytes. Product pages are large but bounded;
 * without a cap a misconfigured URL (a video, a huge file listing) would pull
 * the whole thing into memory during a cron run over every tracked item.
 */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * A browser-shaped User-Agent. Several Finnish stores return a stripped page or
 * a challenge to obviously-automated clients, and a stripped page has no
 * JSON-LD — which would surface as a confusing "no price found" rather than a
 * block.
 */
const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Build the ok:false shape once, so every failure path stays consistent. */
function failure(url: string, error: string): PriceResult {
	return {
		ok: false,
		url,
		price: null,
		currency: null,
		title: null,
		image: null,
		availability: "unknown",
		method: null,
		error,
	};
}

/**
 * Read a response body as text, refusing to buffer more than MAX_BYTES.
 *
 * Uses the stream rather than response.text() so an oversized page is abandoned
 * partway instead of being fully materialised first.
 */
async function readCapped(response: Response): Promise<string | null> {
	const body = response.body;

	if (!body) {
		return null;
	}

	const reader = body.getReader();
	const decoder = new TextDecoder("utf-8");
	const chunks: Array<string> = [];
	let total = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			total += value.byteLength;
			if (total > MAX_BYTES) {
				return null;
			}
			chunks.push(decoder.decode(value, { stream: true }));
		}
		chunks.push(decoder.decode());
	} finally {
		reader.releaseLock();
	}

	return chunks.join("");
}

export async function extractPrice(
	url: string,
	options: ExtractPriceOptions = {},
): Promise<PriceResult> {
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		return failure(url, "not a valid URL");
	}

	if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
		return failure(url, `unsupported protocol: ${parsedUrl.protocol}`);
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort();
	}, REQUEST_TIMEOUT_MS);

	let response: Response;
	try {
		response = await fetch(parsedUrl, {
			signal: controller.signal,
			redirect: "follow",
			headers: {
				"User-Agent": USER_AGENT,
				Accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "fi-FI,fi;q=0.9,en;q=0.8",
			},
		});
	} catch (error) {
		// An aborted fetch and a DNS failure both land here; distinguish them so
		// the recorded error is actionable.
		if (error instanceof Error && error.name === "AbortError") {
			return failure(url, `request timed out after ${REQUEST_TIMEOUT_MS}ms`);
		}
		return failure(
			url,
			error instanceof Error ? error.message : "fetch failed",
		);
	} finally {
		clearTimeout(timeout);
	}

	if (!response.ok) {
		return failure(
			url,
			`HTTP ${response.status} ${response.statusText}`.trim(),
		);
	}

	const contentType = response.headers.get("content-type") ?? "";
	if (
		contentType &&
		!/text\/html|application\/xhtml|text\/plain/i.test(contentType)
	) {
		return failure(url, `unexpected content-type: ${contentType}`);
	}

	let html: string | null;
	try {
		html = await readCapped(response);
	} catch (error) {
		return failure(
			url,
			error instanceof Error ? error.message : "failed to read response body",
		);
	}

	if (html === null) {
		return failure(url, `response exceeded ${MAX_BYTES} bytes or had no body`);
	}

	// Parse against the FINAL URL after redirects, so relative image URLs
	// resolve correctly and per-host selectors match the host actually served.
	const finalUrl = response.url || url;
	const result = parseProductHtml(html, finalUrl, {
		priceSelector: options.priceSelector,
	});

	// The item is keyed by the URL the caller asked for; report that one back
	// regardless of where the redirect chain ended.
	return { ...result, url };
}
