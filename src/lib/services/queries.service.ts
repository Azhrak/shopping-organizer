import { type Kysely, sql } from "kysely";
import {
	computeStats,
	type ItemStats,
	trailingWindowStart,
} from "~/lib/core/pricing";
import type { DB } from "~/lib/db/types";
import type { Availability, ExtractMethod } from "~/lib/extraction/types";

/**
 * Read models for the catalog, detail and comparison views.
 *
 * Framework-agnostic. Prices stay in integer minor units all the way out —
 * formatting happens in the UI.
 */

export type SortKey =
	| "created_desc"
	| "created_asc"
	| "title_asc"
	| "price_asc"
	| "price_desc"
	| "discount_desc";

/**
 * Saved views in the catalog sidebar.
 *
 * - "dropped": price fell within the trailing window (default 7 days).
 * - "at_target": has a target and the current price is at or below it.
 *
 * These are computed from price history rather than stored flags, so they
 * cannot drift out of sync with the data they describe.
 */
export type SmartFilter = "dropped" | "at_target";

export const DROPPED_WINDOW_DAYS = 7;

export interface ListItemsParams {
	folder?: string | null;
	search?: string | null;
	sort?: SortKey;
	includeArchived?: boolean;
	/** Restrict to a saved view. Combines with folder and search. */
	smartFilter?: SmartFilter | null;
	/** Window for the "dropped" filter. Exposed for testing. */
	droppedWindowDays?: number;
	limit?: number;
	offset?: number;
}

export interface ItemListEntry {
	id: string;
	url: string;
	title: string | null;
	image: string | null;
	storeHostname: string;
	currency: string | null;
	folder: string;
	targetPrice: number | null;
	extractFailing: boolean;
	consecutiveFailures: number;
	createdAt: Date;
	archivedAt: Date | null;
	currentPrice: number | null;
	/**
	 * The price observed immediately before currentPrice, or null when the item
	 * has only ever been checked once. Powers the design's struck-through
	 * "was 269,00 €".
	 */
	previousPrice: number | null;
	availability: Availability | null;
	lastCheckedAt: Date | null;
	/**
	 * Recent prices, oldest first, for the card sparkline. Capped server-side —
	 * a card renders a 72px line and cannot use more resolution than this.
	 */
	sparkline: Array<number>;
	/**
	 * Current price against this item's own trailing median, as a signed
	 * percentage (negative = cheaper than typical). Null until there is enough
	 * history to have a typical price. This is the figure the catalog's
	 * discount badge shows.
	 */
	percentVsTypical: number | null;
}

/** How many history points a catalog card's sparkline draws. */
const SPARKLINE_POINTS = 12;

/**
 * List items with their most recent price.
 *
 * The latest price comes from a LATERAL join rather than a GROUP BY: it lets
 * Postgres walk price_checks_item_checked_idx and stop at the first row per
 * item, instead of aggregating the whole history table.
 */
export async function listItems(
	db: Kysely<DB>,
	params: ListItemsParams = {},
): Promise<Array<ItemListEntry>> {
	const {
		folder = null,
		search = null,
		sort = "created_desc",
		includeArchived = false,
		smartFilter = null,
		droppedWindowDays = DROPPED_WINDOW_DAYS,
		limit = 200,
		offset = 0,
	} = params;

	let query = db
		.selectFrom("items as i")
		.leftJoinLateral(
			(eb) =>
				eb
					.selectFrom("price_checks as pc")
					.select(["pc.price", "pc.availability", "pc.checked_at"])
					.whereRef("pc.item_id", "=", "i.id")
					.orderBy("pc.checked_at", "desc")
					.limit(1)
					.as("latest"),
			(join) => join.onTrue(),
		)
		// Second LATERAL for the price before the latest one. OFFSET 1 LIMIT 1
		// walks the same (item_id, checked_at desc) index and stops at the second
		// row, so this stays as cheap as the latest-price join.
		.leftJoinLateral(
			(eb) =>
				eb
					.selectFrom("price_checks as pc")
					.select(["pc.price"])
					.whereRef("pc.item_id", "=", "i.id")
					.orderBy("pc.checked_at", "desc")
					.offset(1)
					.limit(1)
					.as("prev"),
			(join) => join.onTrue(),
		)
		.select([
			"i.id",
			"i.url",
			"i.title",
			"i.image",
			"i.store_hostname",
			"i.currency",
			"i.folder",
			"i.target_price",
			"i.extract_failing",
			"i.consecutive_failures",
			"i.created_at",
			"i.archived_at",
			"i.last_checked_at",
			"latest.price as latest_price",
			"latest.availability as latest_availability",
			"prev.price as previous_price",
		]);

	if (!includeArchived) {
		query = query.where("i.archived_at", "is", null);
	}

	if (folder) {
		query = query.where("i.folder", "=", folder);
	}

	if (search) {
		// Single-user scale: a trigram index is not worth an extension yet.
		const pattern = `%${search}%`;
		query = query.where((eb) =>
			eb.or([eb("i.title", "ilike", pattern), eb("i.url", "ilike", pattern)]),
		);
	}

	if (smartFilter === "at_target") {
		// An item with no target can never be "at target", and one that has
		// never been checked has no price to compare.
		query = query
			.where("i.target_price", "is not", null)
			.whereRef("latest.price", "<=", "i.target_price");
	}

	if (smartFilter === "dropped") {
		const since = new Date(
			Date.now() - droppedWindowDays * 24 * 60 * 60 * 1000,
		);

		// "Dropped" means the newest price is strictly below the price directly
		// preceding it, and that observation is recent. Comparing against the
		// immediate predecessor rather than a window minimum means a price that
		// fell and then recovered does not keep showing up as a drop.
		query = query
			.where("prev.price", "is not", null)
			.whereRef("latest.price", "<", "prev.price")
			.where("latest.checked_at", ">=", since);
	}

	switch (sort) {
		case "created_asc":
			query = query.orderBy("i.created_at", "asc");
			break;
		case "title_asc":
			query = query.orderBy("i.title", "asc");
			break;
		case "price_asc":
			query = query.orderBy("latest.price", "asc");
			break;
		case "price_desc":
			query = query.orderBy("latest.price", "desc");
			break;
		case "discount_desc":
			// Sorted in application code below — it needs the trailing median,
			// which is not available in this query.
			query = query.orderBy("i.created_at", "desc");
			break;
		default:
			query = query.orderBy("i.created_at", "desc");
	}

	const rows = await query.limit(limit).offset(offset).execute();
	const ids = rows.map((r) => r.id);

	const [sparklines, medians] = await Promise.all([
		loadSparklines(db, ids),
		loadTrailingMedians(db, ids),
	]);

	return rows.map((r) => ({
		id: r.id,
		url: r.url,
		title: r.title,
		image: r.image,
		storeHostname: r.store_hostname,
		currency: r.currency,
		folder: r.folder,
		targetPrice: r.target_price,
		extractFailing: r.extract_failing,
		consecutiveFailures: r.consecutive_failures,
		createdAt: r.created_at as Date,
		archivedAt: r.archived_at as Date | null,
		currentPrice: r.latest_price ?? null,
		previousPrice: r.previous_price ?? null,
		availability: (r.latest_availability as Availability | null) ?? null,
		lastCheckedAt: (r.last_checked_at as Date | null) ?? null,
		sparkline: sparklines.get(r.id) ?? [],
		percentVsTypical: percentVsTypical(
			r.latest_price ?? null,
			medians.get(r.id) ?? null,
		),
	}));
}

/**
 * Current price against a trailing median, as a signed percentage.
 *
 * Mirrors the definition in computeStats (~/lib/core/pricing) so a catalog
 * card and the detail view can never disagree about the same number. Kept as
 * a tiny local rather than importing, because the list path has the median
 * already aggregated in SQL and no PricePoint array to hand computeStats.
 */
function percentVsTypical(
	current: number | null,
	medianWindow: number | null,
): number | null {
	if (current === null || medianWindow === null || medianWindow === 0) {
		return null;
	}

	return ((current - medianWindow) / medianWindow) * 100;
}

/**
 * Trailing-window median price per item, computed in Postgres.
 *
 * percentile_cont keeps the aggregate at the database rather than shipping
 * every item's full history to the application just to take a median for a
 * badge. The detail view still uses computeStats over real history, and both
 * use the same 90-day window.
 */
async function loadTrailingMedians(
	db: Kysely<DB>,
	itemIds: Array<string>,
): Promise<Map<string, number>> {
	const result = new Map<string, number>();

	if (itemIds.length === 0) {
		return result;
	}

	const since = trailingWindowStart(new Date());

	const rows = await db
		.selectFrom("price_checks")
		.select([
			"item_id",
			// percentile_cont interpolates, matching median() in pricing.ts for
			// even-sized samples rather than picking a lower/upper neighbour.
			sql<number>`percentile_cont(0.5) within group (order by price)`.as(
				"median",
			),
		])
		.where("item_id", "in", itemIds)
		.where("checked_at", ">=", since)
		.groupBy("item_id")
		.execute();

	for (const row of rows) {
		if (row.median !== null) {
			result.set(row.item_id, Number(row.median));
		}
	}

	return result;
}

/**
 * Recent prices per item for the catalog sparklines, oldest first.
 *
 * One windowed query for the whole page rather than one per card: N cards must
 * not mean N round trips. ROW_NUMBER over the same (item_id, checked_at desc)
 * index takes the newest SPARKLINE_POINTS per item, and the result is reversed
 * so the line reads left-to-right in time order.
 */
async function loadSparklines(
	db: Kysely<DB>,
	itemIds: Array<string>,
): Promise<Map<string, Array<number>>> {
	const result = new Map<string, Array<number>>();

	if (itemIds.length === 0) {
		return result;
	}

	const rows = await db
		.with("ranked", (qb) =>
			qb
				.selectFrom("price_checks")
				.select(({ fn }) => [
					"item_id",
					"price",
					fn
						.agg<number>("row_number")
						.over((ob) =>
							ob.partitionBy("item_id").orderBy("checked_at", "desc"),
						)
						.as("rn"),
				])
				.where("item_id", "in", itemIds),
		)
		.selectFrom("ranked")
		.select(["item_id", "price"])
		.where("rn", "<=", SPARKLINE_POINTS)
		.orderBy("item_id")
		.orderBy("rn", "desc")
		.execute();

	for (const row of rows) {
		const existing = result.get(row.item_id);
		if (existing) {
			existing.push(row.price);
		} else {
			result.set(row.item_id, [row.price]);
		}
	}

	return result;
}

export interface SmartFilterCounts {
	dropped: number;
	atTarget: number;
	archived: number;
}

/**
 * Counts for the sidebar's saved views.
 *
 * Reuses listItems so a count can never disagree with the list it labels —
 * one definition of "dropped", not two. The id-only projection keeps this
 * cheap enough at single-user scale.
 */
export async function getSmartFilterCounts(
	db: Kysely<DB>,
	droppedWindowDays: number = DROPPED_WINDOW_DAYS,
): Promise<SmartFilterCounts> {
	const [dropped, atTarget, archived] = await Promise.all([
		listItems(db, { smartFilter: "dropped", droppedWindowDays, limit: 500 }),
		listItems(db, { smartFilter: "at_target", limit: 500 }),
		db
			.selectFrom("items")
			.select(({ fn }) => fn.count<string>("id").as("count"))
			.where("archived_at", "is not", null)
			.executeTakeFirst(),
	]);

	return {
		dropped: dropped.length,
		atTarget: atTarget.length,
		archived: Number(archived?.count ?? 0),
	};
}

export async function listFolders(
	db: Kysely<DB>,
): Promise<Array<{ folder: string; count: number }>> {
	const rows = await db
		.selectFrom("items")
		.select(({ fn }) => ["folder", fn.count<string>("id").as("count")])
		.where("archived_at", "is", null)
		.groupBy("folder")
		.orderBy("folder", "asc")
		.execute();

	return rows.map((r) => ({ folder: r.folder, count: Number(r.count) }));
}

export interface ItemDetail {
	id: string;
	url: string;
	title: string | null;
	image: string | null;
	storeHostname: string;
	currency: string | null;
	folder: string;
	targetPrice: number | null;
	notes: string | null;
	extractMethod: ExtractMethod | null;
	extractFailing: boolean;
	consecutiveFailures: number;
	createdAt: Date;
	archivedAt: Date | null;
	lastCheckedAt: Date | null;
	nextCheckAt: Date;
	lastAlertPrice: number | null;
	lastAlertedAt: Date | null;
	history: Array<{
		price: number;
		availability: Availability;
		checkedAt: Date;
	}>;
	/** Price observed immediately before the current one, or null. */
	previousPrice: number | null;
	stats: ItemStats;
}

/**
 * An item with its full price history and computed stats.
 *
 * Returns null rather than throwing when the item does not exist, so route
 * loaders can turn it into a 404.
 */
export async function getItemDetail(
	db: Kysely<DB>,
	itemId: string,
	now: Date = new Date(),
): Promise<ItemDetail | null> {
	const item = await db
		.selectFrom("items")
		.selectAll()
		.where("id", "=", itemId)
		.executeTakeFirst();

	if (!item) {
		return null;
	}

	const rows = await db
		.selectFrom("price_checks")
		.select(["price", "availability", "checked_at"])
		.where("item_id", "=", itemId)
		.orderBy("checked_at", "desc")
		.execute();

	const history = rows.map((r) => ({
		price: r.price,
		availability: r.availability as Availability,
		checkedAt: r.checked_at as Date,
	}));

	const stats = computeStats(
		history.map((h) => ({ price: h.price, checkedAt: h.checkedAt })),
		now,
	);

	return {
		id: item.id,
		url: item.url,
		title: item.title,
		image: item.image,
		storeHostname: item.store_hostname,
		currency: item.currency,
		folder: item.folder,
		targetPrice: item.target_price,
		notes: item.notes,
		extractMethod: item.extract_method as ExtractMethod | null,
		extractFailing: item.extract_failing,
		consecutiveFailures: item.consecutive_failures,
		createdAt: item.created_at as Date,
		archivedAt: item.archived_at as Date | null,
		lastCheckedAt: item.last_checked_at as Date | null,
		nextCheckAt: item.next_check_at as Date,
		lastAlertPrice: item.last_alert_price,
		lastAlertedAt: item.last_alerted_at as Date | null,
		history,
		// history is newest-first, so the second entry is the previous price.
		previousPrice: history[1]?.price ?? null,
		stats,
	};
}

export interface GroupDetail {
	id: string;
	name: string;
	createdAt: Date;
	items: Array<ItemDetail & { position: number }>;
}

/**
 * A comparison group with each member's full detail, ordered by position.
 *
 * Each member carries its own percentVsTypical, which is what makes the
 * comparison meaningful across products at different price points.
 */
export async function getGroupDetail(
	db: Kysely<DB>,
	groupId: string,
	now: Date = new Date(),
): Promise<GroupDetail | null> {
	const group = await db
		.selectFrom("comparison_groups")
		.selectAll()
		.where("id", "=", groupId)
		.executeTakeFirst();

	if (!group) {
		return null;
	}

	const members = await db
		.selectFrom("comparison_group_items")
		.select(["item_id", "position"])
		.where("group_id", "=", groupId)
		.orderBy("position", "asc")
		.execute();

	const items = [];
	for (const member of members) {
		const detail = await getItemDetail(db, member.item_id, now);
		if (detail) {
			items.push({ ...detail, position: member.position });
		}
	}

	return {
		id: group.id,
		name: group.name,
		createdAt: group.created_at as Date,
		items,
	};
}

export interface UpdateItemInput {
	targetPrice?: number | null;
	folder?: string;
	notes?: string | null;
	archived?: boolean;
}

/**
 * Update the user-editable fields of an item. Returns false when the item
 * does not exist.
 */
export async function updateItem(
	db: Kysely<DB>,
	itemId: string,
	input: UpdateItemInput,
	now: Date = new Date(),
): Promise<boolean> {
	const patch: Record<string, unknown> = {};

	if (input.targetPrice !== undefined) {
		patch.target_price = input.targetPrice;
	}
	if (input.folder !== undefined) {
		patch.folder = input.folder;
	}
	if (input.notes !== undefined) {
		patch.notes = input.notes;
	}
	if (input.archived !== undefined) {
		patch.archived_at = input.archived ? now : null;
	}

	if (Object.keys(patch).length === 0) {
		return true;
	}

	const result = await db
		.updateTable("items")
		.set(patch)
		.where("id", "=", itemId)
		.executeTakeFirst();

	return result.numUpdatedRows > 0n;
}
