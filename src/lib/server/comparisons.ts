import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { deps } from "~/lib/db/server";
import {
	createGroup,
	DuplicateItemError,
	deleteGroup,
	GroupNotFoundError,
	GroupSizeError,
	listGroups,
	MAX_GROUP_ITEMS,
	MIN_GROUP_ITEMS,
	renameGroup,
	setGroupItems,
	UnknownItemError,
} from "~/lib/services/comparisons.service";
import { getGroupDetail } from "~/lib/services/queries.service";

/**
 * Comparison group CRUD for the in-app surface.
 *
 * The 2-4 size bound is expressed in the zod schema so bad input is rejected
 * before it reaches the database, and enforced again in the service layer,
 * which is the shared implementation both surfaces call.
 */

const itemIds = z.array(z.uuid()).min(MIN_GROUP_ITEMS).max(MAX_GROUP_ITEMS);

/** Translate service errors into messages that survive the RPC boundary. */
function rethrow(error: unknown): never {
	if (
		error instanceof GroupSizeError ||
		error instanceof DuplicateItemError ||
		error instanceof UnknownItemError ||
		error instanceof GroupNotFoundError
	) {
		throw new Error(error.message);
	}
	throw error;
}

export const listGroupsFn = createServerFn({ method: "GET" }).handler(
	async () => {
		return listGroups(deps.db);
	},
);

export const getGroupFn = createServerFn({ method: "GET" })
	.validator(z.object({ groupId: z.uuid() }))
	.handler(async ({ data }) => {
		const detail = await getGroupDetail(deps.db, data.groupId);

		if (!detail) {
			throw new Error(`Comparison group not found: ${data.groupId}`);
		}

		return detail;
	});

export const createGroupFn = createServerFn({ method: "POST" })
	.validator(
		z.object({
			name: z.string().trim().min(1).max(200),
			itemIds,
		}),
	)
	.handler(async ({ data }) => {
		try {
			return await createGroup(deps.db, data.name, data.itemIds);
		} catch (error) {
			rethrow(error);
		}
	});

export const setGroupItemsFn = createServerFn({ method: "POST" })
	.validator(
		z.object({
			groupId: z.uuid(),
			itemIds,
		}),
	)
	.handler(async ({ data }) => {
		try {
			await setGroupItems(deps.db, data.groupId, data.itemIds);
			return { ok: true as const };
		} catch (error) {
			rethrow(error);
		}
	});

export const renameGroupFn = createServerFn({ method: "POST" })
	.validator(
		z.object({
			groupId: z.uuid(),
			name: z.string().trim().min(1).max(200),
		}),
	)
	.handler(async ({ data }) => {
		try {
			await renameGroup(deps.db, data.groupId, data.name);
			return { ok: true as const };
		} catch (error) {
			rethrow(error);
		}
	});

export const deleteGroupFn = createServerFn({ method: "POST" })
	.validator(z.object({ groupId: z.uuid() }))
	.handler(async ({ data }) => {
		try {
			await deleteGroup(deps.db, data.groupId);
			return { ok: true as const };
		} catch (error) {
			rethrow(error);
		}
	});
