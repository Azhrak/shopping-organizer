import type { Kysely } from "kysely";
import { computeStats, type ItemStats } from "~/lib/core/pricing";
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

export interface ListItemsParams {
	folder?: string | null;
	search?: string | null;
	sort?: SortKey;
	includeArchived?: boolean;
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
	availability: Availability | null;
	lastCheckedAt: Date | null;
}

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
		availability: (r.latest_availability as Availability | null) ?? null,
		lastCheckedAt: (r.last_checked_at as Date | null) ?? null,
	}));
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
