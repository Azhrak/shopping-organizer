/**
 * Scheduled price check, runnable as a plain node process.
 *
 * The same checkAllDue() the cron server route calls, so the scheduler is
 * swappable: run this from systemd, host cron, a GitHub Action or a container
 * entrypoint without the app server being involved at all. Nothing about the
 * checking logic lives here — this file is argument parsing, logging and exit
 * codes.
 *
 * It deliberately does NOT import ~/lib/db/server, which pulls in
 * "@tanstack/react-start/server-only" and would fail outside the framework's
 * build. The dependencies are composed directly instead.
 *
 *   pnpm check:due
 *   pnpm check:due -- --limit=50 --concurrency=2 --dry-run
 */

import { closeDatabase, db } from "~/lib/db";
import { extractPrice } from "~/lib/extraction/extractPrice.server";
import { formatEur } from "~/lib/money";
import type { ServiceDeps } from "~/lib/services/items.service";
import { findDueItems } from "~/lib/services/items.service";
import {
	checkAllDue,
	DEFAULT_SCHEDULER_OPTIONS,
} from "~/lib/services/scheduler.service";

interface Options {
	limit: number;
	concurrency: number;
	perHostDelayMs: number;
	/** List what would be checked without contacting any store. */
	dryRun: boolean;
	/** Emit one JSON object instead of human-readable lines. */
	json: boolean;
}

class UsageError extends Error {}

/** Thrown for --help, which is a successful outcome rather than misuse. */
class HelpRequested extends Error {}

function parseNumber(name: string, raw: string, min: number, max: number) {
	const value = Number(raw);

	if (!Number.isInteger(value) || value < min || value > max) {
		throw new UsageError(
			`--${name} must be an integer between ${min} and ${max}, got "${raw}"`,
		);
	}

	return value;
}

function parseArgs(argv: Array<string>): Options {
	const options: Options = {
		limit: DEFAULT_SCHEDULER_OPTIONS.limit,
		concurrency: DEFAULT_SCHEDULER_OPTIONS.concurrency,
		perHostDelayMs: DEFAULT_SCHEDULER_OPTIONS.perHostDelayMs,
		dryRun: false,
		json: false,
	};

	for (const arg of argv) {
		const [flag, raw] = arg.split("=", 2);

		switch (flag) {
			case "--limit":
				options.limit = parseNumber("limit", raw ?? "", 1, 10_000);
				break;
			case "--concurrency":
				options.concurrency = parseNumber("concurrency", raw ?? "", 1, 16);
				break;
			case "--per-host-delay-ms":
				options.perHostDelayMs = parseNumber(
					"per-host-delay-ms",
					raw ?? "",
					0,
					60_000,
				);
				break;
			case "--dry-run":
				options.dryRun = true;
				break;
			case "--json":
				options.json = true;
				break;
			case "--help":
				throw new HelpRequested();
			default:
				throw new UsageError(`Unknown argument: ${arg}`);
		}
	}

	return options;
}

const USAGE = `
Check every tracked item whose next check is due.

Usage: tsx --env-file=.env scripts/check-due.ts [options]

  --limit=N               Max items to check in one run (default ${DEFAULT_SCHEDULER_OPTIONS.limit})
  --concurrency=N         Max extractions in flight (default ${DEFAULT_SCHEDULER_OPTIONS.concurrency})
  --per-host-delay-ms=N   Min gap between requests to one store (default ${DEFAULT_SCHEDULER_OPTIONS.perHostDelayMs})
  --dry-run               List what is due without contacting any store
  --json                  Emit one JSON summary instead of readable lines
  --help                  Show this message

Requires DATABASE_URL in the environment.
`.trim();

async function main(): Promise<number> {
	const options = parseArgs(process.argv.slice(2));

	if (!process.env.DATABASE_URL) {
		console.error("DATABASE_URL is not set.");
		return 2;
	}

	const deps: ServiceDeps = { db, extractPrice };

	if (options.dryRun) {
		const due = await findDueItems(deps, options.limit);

		if (options.json) {
			console.log(JSON.stringify({ dryRun: true, due }, null, 2));
		} else {
			console.log(`${due.length} item(s) due:`);
			for (const item of due) {
				console.log(`  ${item.storeHostname}  ${item.url}`);
			}
		}

		return 0;
	}

	const summary = await checkAllDue(deps, {
		limit: options.limit,
		concurrency: options.concurrency,
		perHostDelayMs: options.perHostDelayMs,
	});

	if (options.json) {
		console.log(
			JSON.stringify({
				...summary,
				startedAt: summary.startedAt.toISOString(),
				finishedAt: summary.finishedAt.toISOString(),
			}),
		);
	} else {
		const seconds = (
			(summary.finishedAt.getTime() - summary.startedAt.getTime()) /
			1000
		).toFixed(1);

		console.log(
			`Checked ${summary.attempted} item(s) in ${seconds}s — ` +
				`${summary.succeeded} ok, ${summary.failed} failed, ${summary.drops} drop(s).`,
		);

		for (const entry of summary.entries) {
			if (entry.isDrop && entry.price !== null) {
				console.log(`  DROP  ${formatEur(entry.price)}  ${entry.url}`);
			}
		}

		for (const entry of summary.entries) {
			if (!entry.ok) {
				console.log(`  FAIL  ${entry.error ?? "unknown error"}  ${entry.url}`);
			}
		}
	}

	// A run where every single item failed is reported as a failure so a
	// scheduler surfaces it. Partial failures are normal — one dead store must
	// not mark the whole run bad — so they exit 0 and are visible in the log.
	if (summary.attempted > 0 && summary.succeeded === 0) {
		return 1;
	}

	return 0;
}

main()
	.then(async (code) => {
		await closeDatabase();
		process.exit(code);
	})
	.catch(async (error) => {
		if (error instanceof HelpRequested) {
			console.log(USAGE);
			await closeDatabase();
			process.exit(0);
		}

		if (error instanceof UsageError) {
			console.error(`${error.message}\n\n${USAGE}`);
			await closeDatabase();
			process.exit(2);
		}

		console.error("Scheduled check failed:", error);
		await closeDatabase();
		process.exit(1);
	});
