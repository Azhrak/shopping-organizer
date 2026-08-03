import type { Kysely } from "kysely";
import type { DB } from "~/lib/db/types";

/**
 * Comparison group logic. Framework-agnostic, like items.service.
 *
 * Group size is 2-4 items. The database enforces the UPPER bound for real
 * (position 0-3 plus a unique index on (group_id, position)); the lower bound
 * cannot be a table constraint because a group is necessarily empty the
 * instant it is created, so it is enforced here.
 */

export const MIN_GROUP_ITEMS = 2;
export const MAX_GROUP_ITEMS = 4;

export class GroupSizeError extends Error {
	constructor(count: number) {
		super(
			`A comparison group needs ${MIN_GROUP_ITEMS}-${MAX_GROUP_ITEMS} items, got ${count}`,
		);
		this.name = "GroupSizeError";
	}
}

export class DuplicateItemError extends Error {
	constructor() {
		super("A comparison group cannot contain the same item twice");
		this.name = "DuplicateItemError";
	}
}

export class GroupNotFoundError extends Error {
	constructor(public readonly groupId: string) {
		super(`Comparison group not found: ${groupId}`);
		this.name = "GroupNotFoundError";
	}
}

export class UnknownItemError extends Error {
	constructor(public readonly itemIds: Array<string>) {
		super(`Unknown item ids: ${itemIds.join(", ")}`);
		this.name = "UnknownItemError";
	}
}

function assertSize(itemIds: Array<string>) {
	if (itemIds.length < MIN_GROUP_ITEMS || itemIds.length > MAX_GROUP_ITEMS) {
		throw new GroupSizeError(itemIds.length);
	}

	if (new Set(itemIds).size !== itemIds.length) {
		throw new DuplicateItemError();
	}
}

/**
 * Verify every id refers to a real item, so a bad id surfaces as a clear
 * error rather than a foreign-key violation.
 */
async function assertItemsExist(db: Kysely<DB>, itemIds: Array<string>) {
	const found = await db
		.selectFrom("items")
		.select("id")
		.where("id", "in", itemIds)
		.execute();

	const foundIds = new Set(found.map((r) => r.id));
	const missing = itemIds.filter((id) => !foundIds.has(id));

	if (missing.length > 0) {
		throw new UnknownItemError(missing);
	}
}

export async function createGroup(
	db: Kysely<DB>,
	name: string,
	itemIds: Array<string>,
): Promise<{ groupId: string }> {
	assertSize(itemIds);
	await assertItemsExist(db, itemIds);

	return db.transaction().execute(async (trx) => {
		const group = await trx
			.insertInto("comparison_groups")
			.values({ name })
			.returning("id")
			.executeTakeFirstOrThrow();

		await trx
			.insertInto("comparison_group_items")
			.values(
				itemIds.map((itemId, index) => ({
					group_id: group.id,
					item_id: itemId,
					position: index,
				})),
			)
			.execute();

		return { groupId: group.id };
	});
}

/**
 * Replace a group's membership wholesale.
 *
 * Deleting then re-inserting inside one transaction avoids fighting the
 * unique (group_id, position) index while positions shuffle.
 */
export async function setGroupItems(
	db: Kysely<DB>,
	groupId: string,
	itemIds: Array<string>,
): Promise<void> {
	assertSize(itemIds);

	const group = await db
		.selectFrom("comparison_groups")
		.select("id")
		.where("id", "=", groupId)
		.executeTakeFirst();

	if (!group) {
		throw new GroupNotFoundError(groupId);
	}

	await assertItemsExist(db, itemIds);

	await db.transaction().execute(async (trx) => {
		await trx
			.deleteFrom("comparison_group_items")
			.where("group_id", "=", groupId)
			.execute();

		await trx
			.insertInto("comparison_group_items")
			.values(
				itemIds.map((itemId, index) => ({
					group_id: groupId,
					item_id: itemId,
					position: index,
				})),
			)
			.execute();
	});
}

export async function renameGroup(
	db: Kysely<DB>,
	groupId: string,
	name: string,
): Promise<void> {
	const result = await db
		.updateTable("comparison_groups")
		.set({ name })
		.where("id", "=", groupId)
		.executeTakeFirst();

	if (result.numUpdatedRows === 0n) {
		throw new GroupNotFoundError(groupId);
	}
}

export async function deleteGroup(
	db: Kysely<DB>,
	groupId: string,
): Promise<void> {
	const result = await db
		.deleteFrom("comparison_groups")
		.where("id", "=", groupId)
		.executeTakeFirst();

	if (result.numDeletedRows === 0n) {
		throw new GroupNotFoundError(groupId);
	}
}

export interface GroupSummary {
	id: string;
	name: string;
	createdAt: Date;
	itemCount: number;
}

export async function listGroups(db: Kysely<DB>): Promise<Array<GroupSummary>> {
	const rows = await db
		.selectFrom("comparison_groups as g")
		.leftJoin("comparison_group_items as gi", "gi.group_id", "g.id")
		.select(({ fn }) => [
			"g.id",
			"g.name",
			"g.created_at",
			fn.count<string>("gi.item_id").as("item_count"),
		])
		.groupBy(["g.id", "g.name", "g.created_at"])
		.orderBy("g.created_at", "desc")
		.execute();

	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		createdAt: r.created_at as Date,
		// count() comes back as a string from pg for bigint results.
		itemCount: Number(r.item_count),
	}));
}
