import {
	useMutation,
	useQueryClient,
	useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";

import { AppLayout, Sidebar } from "~/components/AppShell";
import { ItemCard, ItemRow } from "~/components/ItemCard";
import {
	foldersQuery,
	itemListQuery,
	queryKeys,
	smartCountsQuery,
} from "~/lib/queries";
import { addItemFromUrlFn } from "~/lib/server/items";
import type { ListItemsParams } from "~/lib/services/queries.service";

const sortKeys = [
	"created_desc",
	"created_asc",
	"title_asc",
	"price_asc",
	"price_desc",
	"discount_desc",
] as const;

const searchSchema = z.object({
	folder: z.string().min(1).optional(),
	search: z.string().min(1).optional(),
	sort: z.enum(sortKeys).optional(),
	/** Saved view from the sidebar. */
	view: z.enum(["dropped", "at_target"]).optional(),
	archived: z.boolean().optional(),
	layout: z.enum(["grid", "rows"]).optional(),
});

type CatalogSearch = z.infer<typeof searchSchema>;

/** Translate URL search state into service-layer query params. */
function toListParams(search: CatalogSearch): ListItemsParams {
	return {
		folder: search.folder ?? null,
		search: search.search ?? null,
		sort: search.sort ?? "created_desc",
		smartFilter: search.view ?? null,
		includeArchived: search.archived ?? false,
	};
}

export const Route = createFileRoute("/")({
	validateSearch: searchSchema,
	loaderDeps: ({ search }) => search,
	loader: async ({ context, deps }) => {
		// Prime the cache during SSR so the component's useSuspenseQuery
		// resolves without a client round-trip.
		await Promise.all([
			context.queryClient.ensureQueryData(itemListQuery(toListParams(deps))),
			context.queryClient.ensureQueryData(foldersQuery()),
			context.queryClient.ensureQueryData(smartCountsQuery()),
		]);
	},
	component: CatalogPage,
});

const segmentBase = "px-3 py-1.5 text-[13px] whitespace-nowrap";
const segmentIdle = `${segmentBase} text-muted hover:bg-hair`;
const segmentActive = `${segmentBase} text-accent shadow-[inset_0_0_0_1px_var(--color-accent)]`;

const sortLabels: Array<{ key: (typeof sortKeys)[number]; label: string }> = [
	{ key: "discount_desc", label: "Biggest discount" },
	{ key: "price_asc", label: "Price ↑" },
	{ key: "created_desc", label: "Recently added" },
];

function CatalogPage() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const router = useRouter();
	const queryClient = useQueryClient();

	const listParams = toListParams(search);
	const items = useSuspenseQuery(itemListQuery(listParams));
	const folders = useSuspenseQuery(foldersQuery());
	const counts = useSuspenseQuery(smartCountsQuery());

	const [url, setUrl] = useState("");
	const layout = search.layout ?? "grid";

	const addItem = useMutation({
		mutationFn: (value: string) => addItemFromUrlFn({ data: { url: value } }),
		onSuccess: async () => {
			setUrl("");
			await queryClient.invalidateQueries({ queryKey: queryKeys.items });
			await queryClient.invalidateQueries({ queryKey: queryKeys.folders });
			await queryClient.invalidateQueries({ queryKey: queryKeys.smartCounts });
			await router.invalidate();
		},
	});

	const totalItems = folders.data.reduce((sum, f) => sum + f.count, 0);
	const storeCount = new Set(items.data.map((i) => i.storeHostname)).size;
	const lastCheckedAt = items.data.reduce<Date | null>((latest, item) => {
		if (!item.lastCheckedAt) return latest;
		if (!latest || item.lastCheckedAt > latest) return item.lastCheckedAt;
		return latest;
	}, null);

	return (
		<AppLayout
			sidebar={
				<Sidebar
					folders={folders.data}
					counts={counts.data}
					activeFolder={search.folder ?? null}
					activeSmartFilter={search.view ?? null}
					lastCheckedAt={lastCheckedAt}
					totalItems={totalItems}
					storeCount={storeCount}
				/>
			}
		>
			<section>
				<div data-bar="top" className="mb-4 flex flex-wrap items-center gap-3">
					<div className="flex h-9 min-w-[200px] max-w-[340px] flex-1 items-center gap-2 rounded-lg border border-divider bg-surface px-3">
						<i
							className="ph ph-magnifying-glass text-[15px] text-faint"
							aria-hidden="true"
						/>
						<input
							type="search"
							defaultValue={search.search ?? ""}
							placeholder="Search saved products"
							aria-label="Search saved products"
							onChange={(event) =>
								navigate({
									search: (prev) => ({
										...prev,
										search: event.target.value || undefined,
									}),
								})
							}
							className="min-w-0 flex-1 border-0 bg-transparent text-sm text-text outline-none placeholder:text-faint"
						/>
					</div>

					<form
						className="flex items-center gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							if (url.trim()) {
								addItem.mutate(url.trim());
							}
						}}
					>
						<input
							type="url"
							value={url}
							onChange={(event) => setUrl(event.target.value)}
							placeholder="Paste a product URL"
							aria-label="Product URL to track"
							className="h-9 min-w-[200px] rounded-lg border border-divider bg-surface px-3 text-sm text-text outline-none placeholder:text-faint"
						/>
						<button
							type="submit"
							disabled={addItem.isPending}
							className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg border border-accent px-3 text-sm text-accent hover:bg-accent-tint disabled:opacity-50"
						>
							<i className="ph ph-plus" aria-hidden="true" />
							{addItem.isPending ? "Adding…" : "Add product"}
						</button>
					</form>
				</div>

				{addItem.isError ? (
					<p className="mb-4 rounded-lg bg-surface p-3 text-sm text-good-text shadow-card">
						{addItem.error.message}
					</p>
				) : null}

				<div className="mb-4 flex flex-wrap items-center gap-3">
					<div className="flex flex-wrap items-center gap-1.5">
						<button
							type="button"
							onClick={() =>
								navigate({
									search: (prev) => ({ ...prev, folder: undefined }),
								})
							}
							className={
								search.folder
									? "rounded-md border border-divider px-3 py-1 text-xs text-muted hover:border-accent hover:text-accent"
									: "rounded-md bg-accent-deep px-3 py-1 text-xs text-accent-on-deep"
							}
						>
							All
						</button>
						{folders.data.map(({ folder }) => (
							<button
								key={folder}
								type="button"
								onClick={() =>
									navigate({ search: (prev) => ({ ...prev, folder }) })
								}
								className={
									search.folder === folder
										? "rounded-md bg-accent-deep px-3 py-1 text-xs text-accent-on-deep"
										: "rounded-md border border-divider px-3 py-1 text-xs text-muted hover:border-accent hover:text-accent"
								}
							>
								{folder}
							</button>
						))}
					</div>

					<div className="flex flex-1 items-center justify-end gap-2">
						<span className="text-[11px] uppercase tracking-[0.06em] text-faint">
							Layout
						</span>
						<div className="inline-flex overflow-hidden rounded-lg border border-divider">
							<button
								type="button"
								aria-label="Grid layout"
								onClick={() =>
									navigate({
										search: (prev) => ({ ...prev, layout: "grid" as const }),
									})
								}
								className={layout === "grid" ? segmentActive : segmentIdle}
							>
								<i className="ph ph-squares-four" aria-hidden="true" />
							</button>
							<button
								type="button"
								aria-label="Row layout"
								onClick={() =>
									navigate({
										search: (prev) => ({ ...prev, layout: "rows" as const }),
									})
								}
								className={`border-l border-divider ${
									layout === "rows" ? segmentActive : segmentIdle
								}`}
							>
								<i className="ph ph-rows" aria-hidden="true" />
							</button>
						</div>

						<span className="ml-1.5 text-[11px] uppercase tracking-[0.06em] text-faint">
							Sort
						</span>
						<div className="inline-flex overflow-hidden rounded-lg border border-divider">
							{sortLabels.map(({ key, label }, index) => (
								<button
									key={key}
									type="button"
									onClick={() =>
										navigate({ search: (prev) => ({ ...prev, sort: key }) })
									}
									className={[
										index > 0 ? "border-l border-divider" : "",
										(search.sort ?? "created_desc") === key
											? segmentActive
											: segmentIdle,
									].join(" ")}
								>
									{label}
								</button>
							))}
						</div>
					</div>
				</div>

				{items.data.length === 0 ? (
					<EmptyState search={search} />
				) : layout === "grid" ? (
					<div
						data-grid="cards"
						className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
					>
						{items.data.map((item) => (
							<ItemCard key={item.id} item={item} />
						))}
					</div>
				) : (
					<div className="flex flex-col gap-1.5">
						{items.data.map((item) => (
							<ItemRow key={item.id} item={item} />
						))}
					</div>
				)}

				{items.data.length > 0 ? (
					<div className="mt-6 flex items-center gap-2 text-xs text-faint">
						<i className="ph ph-info" aria-hidden="true" />
						Showing {items.data.length}{" "}
						{items.data.length === 1 ? "item" : "items"}
						{storeCount > 0
							? ` from ${storeCount} ${storeCount === 1 ? "store" : "stores"}`
							: null}
					</div>
				) : null}
			</section>
		</AppLayout>
	);
}

function EmptyState({ search }: { search: CatalogSearch }) {
	const filtered = Boolean(
		search.folder || search.search || search.view || search.archived,
	);

	return (
		<div className="rounded-lg bg-surface p-8 text-center shadow-card">
			<p className="text-sm text-muted">
				{filtered
					? "Nothing matches this view."
					: "Nothing tracked yet. Paste a product URL above to start watching a price."}
			</p>
		</div>
	);
}
