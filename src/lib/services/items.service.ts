import type { Kysely } from "kysely";
import {
	computeStats,
	type DropReason,
	evaluateDrop,
	type ItemStats,
	nextCheckDelayHours,
	type PricePoint,
	trailingWindowStart,
} from "~/lib/core/pricing";
import type { DB } from "~/lib/db/types";
import type { ExtractPriceFn, PriceResult } from "~/lib/extraction/types";
import { toMinorUnits } from "~/lib/money";
import { normaliseUrl } from "~/lib/url";

/**
 * Business logic for saving and checking tracked items.
 *
 * Framework-agnostic by design: no TanStack Start imports anywhere in this
 * file. Both surfaces call these functions — server functions for the in-app
 * UI, server routes for the Chrome extension and cron trigger — so there is
 * exactly one implementation of "add an item" and "check an item".
 *
 * The database handle and the extractor are passed in rather than imported,
 * which keeps this layer testable against a real Postgres without reaching
 * for the module registry.
 */

export interface ServiceDeps {
	db: Kysely<DB>;
	extractPrice: ExtractPriceFn;
	/** Injectable clock so scheduling and window maths are testable. */
	now?: () => Date;
}

export interface CheckPolicy {
	/** Hours between checks for a healthy item. */
	baseIntervalHours: number;
	/** Ceiling for the exponential backoff on failing items. */
	maxIntervalHours: number;
}

export const DEFAULT_CHECK_POLICY: CheckPolicy = {
	baseIntervalHours: 12,
	maxIntervalHours: 24 * 7,
};

function clock(deps: ServiceDeps): Date {
	return deps.now ? deps.now() : new Date();
}

function hoursFrom(base: Date, hours: number): Date {
	return new Date(base.getTime() + hours * 60 * 60 * 1000);
}

export interface AddItemResult {
	itemId: string;
	/** False when the URL was already tracked and no new row was created. */
	created: boolean;
	/** True when extraction failed and the item was saved untracked. */
	extractFailing: boolean;
	title: string | null;
	price: number | null;
	error?: string;
}

/**
 * Save a URL as a tracked item.
 *
 * A failed extraction still saves the item with extract_failing = true: a
 * saved-but-untracked item can be fixed later, a silently dropped URL cannot.
 *
 * Adding a URL that is already tracked is not an error — it returns the
 * existing item with created:false, which is what the extension's bulk import
 * needs when a tab is captured twice.
 */
export async function addItem(
	deps: ServiceDeps,
	rawUrl: string,
	options: { policy?: CheckPolicy } = {},
): Promise<AddItemResult> {
	const policy = options.policy ?? DEFAULT_CHECK_POLICY;
	const now = clock(deps);

	const normalised = normaliseUrl(rawUrl);
	if (!normalised) {
		throw new InvalidUrlError(rawUrl);
	}

	const existing = await deps.db
		.selectFrom("items")
		.select(["id", "title", "extract_failing"])
		.where("url", "=", normalised.url)
		.executeTakeFirst();

	if (existing) {
		return {
			itemId: existing.id,
			created: false,
			extractFailing: existing.extract_failing,
			title: existing.title,
			price: null,
		};
	}

	// As in checkItem: a throwing extractor must not lose the URL. Saving the
	// item with extract_failing = true is the whole point of this function's
	// contract, and that applies whether extraction returned ok:false or blew
	// up outright.
	let result: PriceResult;
	try {
		result = await deps.extractPrice(normalised.url);
	} catch (error) {
		result = {
			ok: false,
			url: normalised.url,
			price: null,
			currency: null,
			title: null,
			image: null,
			availability: "unknown",
			method: null,
			error: error instanceof Error ? error.message : "extraction threw",
		};
	}

	const minorPrice =
		result.ok && result.price !== null ? toMinorUnits(result.price) : null;

	// An ok:true result whose price will not convert cleanly is treated as a
	// failure rather than stored as a wrong number.
	const usable = result.ok && minorPrice !== null;

	const item = await deps.db
		.insertInto("items")
		.values({
			url: normalised.url,
			store_hostname: normalised.hostname,
			title: result.title,
			image: result.image,
			currency: result.currency,
			extract_method: usable ? result.method : null,
			extract_failing: !usable,
			consecutive_failures: usable ? 0 : 1,
			last_checked_at: now,
			next_check_at: hoursFrom(
				now,
				nextCheckDelayHours(
					usable ? 0 : 1,
					policy.baseIntervalHours,
					policy.maxIntervalHours,
				),
			),
		})
		.returning(["id", "title"])
		.executeTakeFirstOrThrow();

	if (usable) {
		await deps.db
			.insertInto("price_checks")
			.values({
				item_id: item.id,
				price: minorPrice as number,
				availability: result.availability,
				checked_at: now,
			})
			.execute();
	}

	return {
		itemId: item.id,
		created: true,
		extractFailing: !usable,
		title: item.title,
		price: usable ? minorPrice : null,
		error: usable ? undefined : (result.error ?? "extraction failed"),
	};
}

export class InvalidUrlError extends Error {
	constructor(public readonly url: string) {
		super(`Not a usable http(s) URL: ${url}`);
		this.name = "InvalidUrlError";
	}
}

export class ItemNotFoundError extends Error {
	constructor(public readonly itemId: string) {
		super(`Item not found: ${itemId}`);
		this.name = "ItemNotFoundError";
	}
}

export interface CheckItemResult {
	itemId: string;
	ok: boolean;
	price: number | null;
	previousPrice: number | null;
	isDrop: boolean;
	dropReason: DropReason | null;
	consecutiveFailures: number;
	nextCheckAt: Date;
	error?: string;
}

/**
 * Re-extract an item's price, append a price_check, and report whether this
 * constitutes a drop event.
 *
 * On failure NO price_check row is written — the history table stays a pure
 * record of observed prices. The failure is recorded on the item instead
 * (consecutive_failures, extract_failing) and the next check is pushed out by
 * exponential backoff.
 */
export async function checkItem(
	deps: ServiceDeps,
	itemId: string,
	options: { policy?: CheckPolicy } = {},
): Promise<CheckItemResult> {
	const policy = options.policy ?? DEFAULT_CHECK_POLICY;
	const now = clock(deps);

	const item = await deps.db
		.selectFrom("items")
		.select([
			"id",
			"url",
			"target_price",
			"last_alert_price",
			"consecutive_failures",
		])
		.where("id", "=", itemId)
		.executeTakeFirst();

	if (!item) {
		throw new ItemNotFoundError(itemId);
	}

	// A throwing extractor is treated exactly like an ok:false result. The
	// contract says it returns ok:false rather than throwing, but a network
	// error, a DNS failure or a bug inside the module will throw anyway — and
	// if that escaped here, the failure would never be recorded, next_check_at
	// would never advance, and the item would be retried on every single run
	// instead of backing off.
	let result: PriceResult;
	try {
		result = await deps.extractPrice(item.url);
	} catch (error) {
		result = {
			ok: false,
			url: item.url,
			price: null,
			currency: null,
			title: null,
			image: null,
			availability: "unknown",
			method: null,
			error: error instanceof Error ? error.message : "extraction threw",
		};
	}

	const minorPrice =
		result.ok && result.price !== null ? toMinorUnits(result.price) : null;
	const usable = result.ok && minorPrice !== null;

	if (!usable) {
		const failures = item.consecutive_failures + 1;
		const nextCheckAt = hoursFrom(
			now,
			nextCheckDelayHours(
				failures,
				policy.baseIntervalHours,
				policy.maxIntervalHours,
			),
		);

		await deps.db
			.updateTable("items")
			.set({
				extract_failing: true,
				consecutive_failures: failures,
				last_checked_at: now,
				next_check_at: nextCheckAt,
			})
			.where("id", "=", item.id)
			.execute();

		return {
			itemId: item.id,
			ok: false,
			price: null,
			previousPrice: null,
			isDrop: false,
			dropReason: null,
			consecutiveFailures: failures,
			nextCheckAt,
			error: result.error ?? "extraction failed",
		};
	}

	const price = minorPrice as number;

	const previous = await deps.db
		.selectFrom("price_checks")
		.select("price")
		.where("item_id", "=", item.id)
		.orderBy("checked_at", "desc")
		.limit(1)
		.executeTakeFirst();

	const windowStart = trailingWindowStart(now);
	const trailingLowRow = await deps.db
		.selectFrom("price_checks")
		.select(({ fn }) => fn.min<number>("price").as("low"))
		.where("item_id", "=", item.id)
		.where("checked_at", ">=", windowStart)
		.executeTakeFirst();

	const drop = evaluateDrop({
		newPrice: price,
		previousPrice: previous?.price ?? null,
		targetPrice: item.target_price,
		trailingLow: trailingLowRow?.low ?? null,
		lastAlertPrice: item.last_alert_price,
	});

	const nextCheckAt = hoursFrom(
		now,
		nextCheckDelayHours(0, policy.baseIntervalHours, policy.maxIntervalHours),
	);

	// Append the observation and update item state together, so a crash cannot
	// leave a recorded price without its matching schedule/alert bookkeeping.
	await deps.db.transaction().execute(async (trx) => {
		await trx
			.insertInto("price_checks")
			.values({
				item_id: item.id,
				price,
				availability: result.availability,
				checked_at: now,
			})
			.execute();

		await trx
			.updateTable("items")
			.set({
				extract_failing: false,
				consecutive_failures: 0,
				last_checked_at: now,
				next_check_at: nextCheckAt,
				extract_method: result.method,
				// Refresh presentation fields that may have been missing when the
				// item was first saved while failing.
				title: result.title,
				image: result.image,
				currency: result.currency,
				...(drop.isDrop
					? { last_alert_price: price, last_alerted_at: now }
					: {}),
			})
			.where("id", "=", item.id)
			.execute();
	});

	return {
		itemId: item.id,
		ok: true,
		price,
		previousPrice: previous?.price ?? null,
		isDrop: drop.isDrop,
		dropReason: drop.reason,
		consecutiveFailures: 0,
		nextCheckAt,
	};
}

/**
 * Full statistics for an item, including the percent-vs-typical figure that
 * powers the comparison view.
 *
 * Loads the item's history and computes in application code rather than SQL:
 * the maths lives in one pure, exhaustively tested place, and a single item's
 * history is small enough that this is not worth pushing into the database.
 */
export async function getItemStats(
	deps: ServiceDeps,
	itemId: string,
): Promise<ItemStats> {
	const now = clock(deps);

	const exists = await deps.db
		.selectFrom("items")
		.select("id")
		.where("id", "=", itemId)
		.executeTakeFirst();

	if (!exists) {
		throw new ItemNotFoundError(itemId);
	}

	const rows = await deps.db
		.selectFrom("price_checks")
		.select(["price", "checked_at"])
		.where("item_id", "=", itemId)
		.orderBy("checked_at", "desc")
		.execute();

	const points: Array<PricePoint> = rows.map((r) => ({
		price: r.price,
		checkedAt: r.checked_at as Date,
	}));

	return computeStats(points, now);
}

/**
 * Items whose next_check_at has come due, oldest first.
 *
 * Archived items are excluded and the query is served by items_due_idx.
 */
export async function findDueItems(
	deps: ServiceDeps,
	limit: number,
): Promise<Array<{ id: string; url: string; storeHostname: string }>> {
	const now = clock(deps);

	const rows = await deps.db
		.selectFrom("items")
		.select(["id", "url", "store_hostname"])
		.where("archived_at", "is", null)
		.where("next_check_at", "<=", now)
		.orderBy("next_check_at", "asc")
		.limit(limit)
		.execute();

	return rows.map((r) => ({
		id: r.id,
		url: r.url,
		storeHostname: r.store_hostname,
	}));
}
