import {
	errorMessage,
	mapSettledWithConcurrency,
} from "~/lib/core/concurrency";
import {
	type CheckPolicy,
	checkItem,
	DEFAULT_CHECK_POLICY,
	findDueItems,
	type ServiceDeps,
} from "~/lib/services/items.service";

/**
 * Scheduled price checking.
 *
 * Framework-agnostic: no TanStack Start imports. Called from the cron server
 * route (POST /api/cron/check) and, in step 5, from a plain node script — so
 * the scheduler is swappable across hosts without touching this logic.
 *
 * Per-hostname serialisation and request staggering live here rather than in
 * the route, because both entry points need identical behaviour toward the
 * stores being scraped.
 */

export interface CheckAllDueOptions {
	/** Maximum items to check in one run. Bounds a run's wall time. */
	limit?: number;
	/** Maximum extractions in flight across all hosts. */
	concurrency?: number;
	/** Minimum gap between two requests to the SAME hostname. */
	perHostDelayMs?: number;
	policy?: CheckPolicy;
}

export const DEFAULT_SCHEDULER_OPTIONS: Required<
	Omit<CheckAllDueOptions, "policy">
> & {
	policy: CheckPolicy;
} = {
	limit: 100,
	concurrency: 4,
	perHostDelayMs: 2000,
	policy: DEFAULT_CHECK_POLICY,
};

export interface CheckAllDueEntry {
	itemId: string;
	url: string;
	ok: boolean;
	price: number | null;
	isDrop: boolean;
	error?: string;
}

export interface CheckAllDueSummary {
	/** Items that were due and attempted. */
	attempted: number;
	succeeded: number;
	failed: number;
	drops: number;
	entries: Array<CheckAllDueEntry>;
	startedAt: Date;
	finishedAt: Date;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serialises work per hostname with a minimum gap between requests.
 *
 * Concurrency alone is not enough: four workers could all pull items from the
 * same store and hit it simultaneously. Each hostname gets a promise chain,
 * so requests to one store queue behind each other while different stores
 * still proceed in parallel.
 */
function createHostGate(delayMs: number) {
	const chains = new Map<string, Promise<void>>();

	return function gate<T>(
		hostname: string,
		task: () => Promise<T>,
	): Promise<T> {
		const previous = chains.get(hostname) ?? Promise.resolve();

		const run = previous.then(task);

		// The chain advances on both success and failure — a failing store must
		// not wedge its own queue — and holds the delay so the NEXT request to
		// this host waits, without delaying the current one.
		chains.set(
			hostname,
			run.then(
				() => sleep(delayMs),
				() => sleep(delayMs),
			),
		);

		return run;
	};
}

/**
 * Check every item whose next_check_at has come due.
 *
 * Resilient by construction: checkItem already converts an extraction failure
 * into recorded failure state plus backoff, and mapSettledWithConcurrency
 * captures anything that still throws (a database blip, say) so one bad item
 * cannot abandon the rest of the run.
 */
export async function checkAllDue(
	deps: ServiceDeps,
	options: CheckAllDueOptions = {},
): Promise<CheckAllDueSummary> {
	const {
		limit = DEFAULT_SCHEDULER_OPTIONS.limit,
		concurrency = DEFAULT_SCHEDULER_OPTIONS.concurrency,
		perHostDelayMs = DEFAULT_SCHEDULER_OPTIONS.perHostDelayMs,
		policy = DEFAULT_SCHEDULER_OPTIONS.policy,
	} = options;

	const startedAt = deps.now ? deps.now() : new Date();

	// findDueItems already filters on archived_at IS NULL and next_check_at <=
	// now, ordered oldest-first, so exponential backoff on failing items is
	// enforced by the query rather than re-checked here.
	const due = await findDueItems(deps, limit);

	const gate = createHostGate(perHostDelayMs);

	const settled = await mapSettledWithConcurrency(due, concurrency, (item) =>
		gate(item.storeHostname, async () => {
			const result = await checkItem(deps, item.id, { policy });
			return { item, result };
		}),
	);

	const entries: Array<CheckAllDueEntry> = settled.map((outcome, index) => {
		const item = due[index] as (typeof due)[number];

		if (outcome.status === "rejected") {
			return {
				itemId: item.id,
				url: item.url,
				ok: false,
				price: null,
				isDrop: false,
				error: errorMessage(outcome.reason),
			};
		}

		const { result } = outcome.value;

		return {
			itemId: result.itemId,
			url: item.url,
			ok: result.ok,
			price: result.price,
			isDrop: result.isDrop,
			error: result.error,
		};
	});

	const succeeded = entries.filter((entry) => entry.ok).length;

	return {
		attempted: entries.length,
		succeeded,
		failed: entries.length - succeeded,
		drops: entries.filter((entry) => entry.isDrop).length,
		entries,
		startedAt,
		finishedAt: deps.now ? deps.now() : new Date(),
	};
}
