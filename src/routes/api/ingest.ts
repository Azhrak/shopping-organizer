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

const ingestSchema = z.object({
	urls: z.array(z.string().min(1)).min(1).max(MAX_URLS),
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

				// De-duplicate within the batch before doing any work: the extension
				// captures every open tab, and the same product is often open twice.
				const urls = [...new Set(parsed.data.urls.map((url) => url.trim()))];

				const settled = await mapSettledWithConcurrency(
					urls,
					INGEST_CONCURRENCY,
					(url) => addItem(deps, url),
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
