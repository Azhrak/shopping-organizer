import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { deps } from "~/lib/db/server";
import {
	addItem,
	checkItem,
	InvalidUrlError,
	ItemNotFoundError,
} from "~/lib/services/items.service";
import {
	getItemDetail,
	getSmartFilterCounts,
	listFolders,
	listItems,
	updateItem,
} from "~/lib/services/queries.service";

/**
 * In-app surface: server functions called from route loaders and TanStack
 * Query mutations. Type-safe end to end.
 *
 * These are protected by Start's CSRF middleware (see src/start.ts) because
 * they are same-origin RPC. Outside callers — the Chrome extension and the
 * cron trigger — use server ROUTES under src/routes/api instead, since they
 * cannot send same-origin headers.
 *
 * Every function validates its input with zod. Business logic lives in the
 * service layer; these are thin adapters over it.
 */

const sortKey = z.enum([
	"created_desc",
	"created_asc",
	"title_asc",
	"price_asc",
	"price_desc",
	"discount_desc",
]);

const smartFilter = z.enum(["dropped", "at_target"]);

export const listItemsFn = createServerFn({ method: "GET" })
	.validator(
		z.object({
			folder: z.string().min(1).nullable().optional(),
			search: z.string().trim().min(1).nullable().optional(),
			sort: sortKey.optional(),
			includeArchived: z.boolean().optional(),
			smartFilter: smartFilter.nullable().optional(),
			limit: z.number().int().min(1).max(500).optional(),
			offset: z.number().int().min(0).optional(),
		}),
	)
	.handler(async ({ data }) => {
		return listItems(deps.db, data);
	});

export const listFoldersFn = createServerFn({ method: "GET" }).handler(
	async () => {
		return listFolders(deps.db);
	},
);

/** Counts for the sidebar's saved views. */
export const smartFilterCountsFn = createServerFn({ method: "GET" }).handler(
	async () => {
		return getSmartFilterCounts(deps.db);
	},
);

export const getItemFn = createServerFn({ method: "GET" })
	.validator(z.object({ itemId: z.uuid() }))
	.handler(async ({ data }) => {
		const detail = await getItemDetail(deps.db, data.itemId);

		if (!detail) {
			throw new Error(`Item not found: ${data.itemId}`);
		}

		return detail;
	});

export const addItemFromUrlFn = createServerFn({ method: "POST" })
	.validator(z.object({ url: z.string().min(1) }))
	.handler(async ({ data }) => {
		try {
			return await addItem(deps, data.url);
		} catch (error) {
			if (error instanceof InvalidUrlError) {
				throw new Error(`Not a usable http(s) URL: ${data.url}`);
			}
			throw error;
		}
	});

export const updateItemFn = createServerFn({ method: "POST" })
	.validator(
		z.object({
			itemId: z.uuid(),
			// Minor units. Null clears the target.
			targetPrice: z.number().int().positive().nullable().optional(),
			folder: z.string().trim().min(1).max(100).optional(),
			notes: z.string().max(10_000).nullable().optional(),
			archived: z.boolean().optional(),
		}),
	)
	.handler(async ({ data }) => {
		const { itemId, ...patch } = data;
		const updated = await updateItem(deps.db, itemId, patch);

		if (!updated) {
			throw new Error(`Item not found: ${itemId}`);
		}

		return { ok: true as const };
	});

export const checkItemNowFn = createServerFn({ method: "POST" })
	.validator(z.object({ itemId: z.uuid() }))
	.handler(async ({ data }) => {
		try {
			return await checkItem(deps, data.itemId);
		} catch (error) {
			if (error instanceof ItemNotFoundError) {
				throw new Error(`Item not found: ${data.itemId}`);
			}
			throw error;
		}
	});
