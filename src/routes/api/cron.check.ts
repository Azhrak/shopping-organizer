import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { deps } from "~/lib/db/server";
import {
	authenticateExternal,
	authFailureMessage,
	jsonResponse,
	preflightResponse,
} from "~/lib/server/externalAuth";
import {
	checkAllDue,
	DEFAULT_SCHEDULER_OPTIONS,
} from "~/lib/services/scheduler.service";

/**
 * POST /api/cron/check — trigger a scheduled check run.
 *
 * A server ROUTE for the same reason as /api/ingest: the caller is an external
 * scheduler (systemd timer, GitHub Action, host cron) that cannot send
 * same-origin headers. Shared-secret header only.
 *
 * Thin wrapper over checkAllDue() in the service layer, which is the identical
 * entry point the plain node script uses in step 5 — the scheduler stays
 * swappable across hosts because neither side owns the logic.
 */

const optionsSchema = z
	.object({
		limit: z.number().int().min(1).max(1000).optional(),
		concurrency: z.number().int().min(1).max(16).optional(),
		perHostDelayMs: z.number().int().min(0).max(60_000).optional(),
	})
	.optional();

export const Route = createFileRoute("/api/cron/check")({
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

				// An empty body is the normal case — a cron caller usually posts
				// nothing and wants the defaults.
				let body: unknown;
				const raw = await request.text();
				if (raw.trim().length === 0) {
					body = undefined;
				} else {
					try {
						body = JSON.parse(raw);
					} catch {
						return jsonResponse(
							request,
							{ error: "Body must be JSON or empty." },
							400,
						);
					}
				}

				const parsed = optionsSchema.safeParse(body);
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

				const summary = await checkAllDue(deps, {
					limit: parsed.data?.limit ?? DEFAULT_SCHEDULER_OPTIONS.limit,
					concurrency:
						parsed.data?.concurrency ?? DEFAULT_SCHEDULER_OPTIONS.concurrency,
					perHostDelayMs:
						parsed.data?.perHostDelayMs ??
						DEFAULT_SCHEDULER_OPTIONS.perHostDelayMs,
				});

				// Per-item detail is deliberately omitted: a cron caller logs the
				// response, and dumping every URL into the scheduler's log every run
				// buries the signal. The full detail is in the database.
				return jsonResponse(request, {
					attempted: summary.attempted,
					succeeded: summary.succeeded,
					failed: summary.failed,
					drops: summary.drops,
					startedAt: summary.startedAt.toISOString(),
					finishedAt: summary.finishedAt.toISOString(),
					durationMs:
						summary.finishedAt.getTime() - summary.startedAt.getTime(),
				});
			},
		},
	},
});
