import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import {
	errorMessage,
	mapSettledWithConcurrency,
} from "~/lib/core/concurrency";
import { deps } from "~/lib/db/server";
import {
	authenticateExternal,
	authFailureMessage,
	jsonResponse,
	preflightResponse,
} from "~/lib/server/externalAuth";
import { addItem, InvalidUrlError } from "~/lib/services/items.service";

/**
 * POST /api/ingest — bulk import from the Chrome extension.
 *
 * A server ROUTE, not a server function: the extension sends a
 * chrome-extension:// Origin, which Start's CSRF middleware rejects. The
 * filter in src/start.ts limits CSRF to handlerType === "serverFn", so this
 * route is outside its scope by construction; the shared-secret header is the
 * gate instead.
 *
 * Thin wrapper: all behaviour is addItem() from the service layer, the same
 * function the in-app "add URL" server function calls.
 */

const MAX_URLS = 200;

/** Matches the extension's popup budget — see step 6. */
const INGEST_CONCURRENCY = 4;

/**
 * An entry is either a bare URL — what "grab open tabs" has always sent — or an
 * object carrying what the price picker captured. The union keeps the existing
 * bulk path byte-for-byte compatible.
 *
 * `observedPrice` is in MAJOR units (14.99), matching PriceResult.price. The
 * service layer converts to integer minor units via toMinorUnits(); nothing new
 * converts here.
 */
const ingestEntrySchema = z.union([
	z.string().min(1),
	z.object({
		url: z.string().min(1),
		// Bounded to match the items_price_selector_length check constraint, so a
		// too-long selector is a clean 400 rather than a database error.
		priceSelector: z.string().min(1).max(500).optional(),
		// A ceiling as well as a floor: the value is client-supplied, and a
		// mis-parse writing an absurd price would silently skew every stat that
		// averages over it.
		observedPrice: z.number().positive().finite().max(10_000_000).optional(),
		observedCurrency: z.string().length(3).optional(),
		observedAvailability: z
			.enum(["in_stock", "out_of_stock", "unknown"])
			.optional(),
	}),
]);

const ingestSchema = z.object({
	urls: z.array(ingestEntrySchema).min(1).max(MAX_URLS),
});

export type IngestEntry = {
	url: string;
	ok: boolean;
	itemId?: string;
	/** False when the URL was already tracked — not an error. */
	created?: boolean;
	/** True when the item was saved but its price could not be extracted. */
	extractFailing?: boolean;
	title?: string | null;
	/** Recorded price in MINOR units, when one was stored. */
	price?: number | null;
	error?: string;
};

export type IngestResponse = {
	saved: number;
	failed: number;
	duplicates: number;
	results: Array<IngestEntry>;
};

export const Route = createFileRoute("/api/ingest")({
	server: {
		handlers: {
			OPTIONS: ({ request }) => preflightResponse(request),

			POST: async ({ request }) => {
				const auth = authenticateExternal(request);
				if (!auth.ok) {
					return jsonResponse(
						request,
						{ error: authFailureMessage(auth.reason) },
						auth.status,
					);
				}

				let body: unknown;
				try {
					body = await request.json();
				} catch {
					return jsonResponse(request, { error: "Body must be JSON." }, 400);
				}

				const parsed = ingestSchema.safeParse(body);
				if (!parsed.success) {
					return jsonResponse(
						request,
						{
							error: "Invalid request body.",
							issues: z.treeifyError(parsed.error),
						},
						400,
					);
				}

				// Normalise both entry shapes to one before doing any work.
				const entries = parsed.data.urls.map((entry) =>
					typeof entry === "string"
						? { url: entry.trim() }
						: { ...entry, url: entry.url.trim() },
				);

				// De-duplicate within the batch: the extension captures every open
				// tab, and the same product is often open twice. Later entries win,
				// so a picker capture beats a bare URL for the same page rather than
				// being dropped by whichever happened to arrive first.
				const byUrl = new Map<string, (typeof entries)[number]>();
				for (const entry of entries) {
					const previous = byUrl.get(entry.url);
					byUrl.set(entry.url, previous ? { ...previous, ...entry } : entry);
				}

				const deduped = [...byUrl.values()];
				const urls = deduped.map((entry) => entry.url);

				const settled = await mapSettledWithConcurrency(
					deduped,
					INGEST_CONCURRENCY,
					(entry) =>
						addItem(deps, entry.url, {
							priceSelector: entry.priceSelector,
							observedPrice: entry.observedPrice,
							observedCurrency: entry.observedCurrency,
							observedAvailability: entry.observedAvailability,
						}),
				);

				const results: Array<IngestEntry> = settled.map((outcome, index) => {
					const url = urls[index] as string;

					if (outcome.status === "rejected") {
						// An unusable URL is a per-entry failure, never a 4xx for the
						// whole batch — one chrome:// tab must not lose the other 40.
						const reason = outcome.reason;
						return {
							url,
							ok: false,
							error:
								reason instanceof InvalidUrlError
									? "Not a usable http(s) URL"
									: errorMessage(reason),
						};
					}

					const result = outcome.value;

					return {
						url,
						ok: true,
						itemId: result.itemId,
						created: result.created,
						extractFailing: result.extractFailing,
						title: result.title,
						price: result.price,
						// addItem saves the item even when extraction fails; surface why
						// so the popup can distinguish "saved, untracked" from "saved".
						error: result.error,
					};
				});

				const body_: IngestResponse = {
					saved: results.filter((r) => r.ok && r.created).length,
					failed: results.filter((r) => !r.ok).length,
					duplicates: results.filter((r) => r.ok && r.created === false).length,
					results,
				};

				return jsonResponse(request, body_);
			},
		},
	},
});
