import { queryOptions } from "@tanstack/react-query";

import { getGroupFn, listGroupsFn } from "~/lib/server/comparisons";
import {
	getItemFn,
	listFoldersFn,
	listItemsFn,
	smartFilterCountsFn,
} from "~/lib/server/items";
import type { ListItemsParams } from "~/lib/services/queries.service";

/**
 * Shared query definitions.
 *
 * Route loaders call ensureQueryData with these, and components call
 * useSuspenseQuery with the same objects, so SSR priming and client caching
 * agree on one key per resource. Mutations invalidate by the same keys.
 */

export const queryKeys = {
	items: ["items"] as const,
	itemList: (params: ListItemsParams) => ["items", "list", params] as const,
	item: (itemId: string) => ["items", "detail", itemId] as const,
	folders: ["folders"] as const,
	smartCounts: ["smart-counts"] as const,
	groups: ["groups"] as const,
	group: (groupId: string) => ["groups", "detail", groupId] as const,
};

export function itemListQuery(params: ListItemsParams = {}) {
	return queryOptions({
		queryKey: queryKeys.itemList(params),
		queryFn: () => listItemsFn({ data: params }),
	});
}

export function itemQuery(itemId: string) {
	return queryOptions({
		queryKey: queryKeys.item(itemId),
		queryFn: () => getItemFn({ data: { itemId } }),
	});
}

export function foldersQuery() {
	return queryOptions({
		queryKey: queryKeys.folders,
		queryFn: () => listFoldersFn(),
	});
}

export function smartCountsQuery() {
	return queryOptions({
		queryKey: queryKeys.smartCounts,
		queryFn: () => smartFilterCountsFn(),
	});
}

export function groupsQuery() {
	return queryOptions({
		queryKey: queryKeys.groups,
		queryFn: () => listGroupsFn(),
	});
}

export function groupQuery(groupId: string) {
	return queryOptions({
		queryKey: queryKeys.group(groupId),
		queryFn: () => getGroupFn({ data: { groupId } }),
	});
}
