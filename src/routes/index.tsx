import {
	useMutation,
	useQueryClient,
	useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";

import { ItemCard } from "~/components/ItemCard";
import { foldersQuery, itemListQuery, queryKeys } from "~/lib/queries";
import { addItemFromUrlFn } from "~/lib/server/items";

const searchSchema = z.object({
	folder: z.string().min(1).optional(),
	search: z.string().min(1).optional(),
	sort: z
		.enum([
			"created_desc",
			"created_asc",
			"title_asc",
			"price_asc",
			"price_desc",
			"discount_desc",
		])
		.optional(),
});

export const Route = createFileRoute("/")({
	validateSearch: searchSchema,
	loaderDeps: ({ search }) => search,
	loader: async ({ context, deps }) => {
		// Prime the cache during SSR so the component's useSuspenseQuery
		// resolves without a client round-trip.
		await Promise.all([
			context.queryClient.ensureQueryData(itemListQuery(deps)),
			context.queryClient.ensureQueryData(foldersQuery()),
		]);
	},
	component: CatalogPage,
});

function CatalogPage() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const router = useRouter();
	const queryClient = useQueryClient();

	const items = useSuspenseQuery(itemListQuery(search));
	const folders = useSuspenseQuery(foldersQuery());

	const [url, setUrl] = useState("");

	const addItem = useMutation({
		mutationFn: (value: string) => addItemFromUrlFn({ data: { url: value } }),
		onSuccess: async () => {
			setUrl("");
			await queryClient.invalidateQueries({ queryKey: queryKeys.items });
			await queryClient.invalidateQueries({ queryKey: queryKeys.folders });
			await router.invalidate();
		},
	});

	return (
		<div className="space-y-6">
			<form
				className="flex gap-2"
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
					placeholder="https://…"
					className="flex-1 rounded border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
				/>
				<button
					type="submit"
					disabled={addItem.isPending}
					className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
				>
					{addItem.isPending ? "Adding…" : "Add"}
				</button>
			</form>

			{addItem.isError && (
				<p className="text-sm text-rose-600">{addItem.error.message}</p>
			)}

			<div className="flex flex-wrap items-center gap-3 text-sm">
				<select
					value={search.folder ?? ""}
					onChange={(event) =>
						navigate({
							search: (prev) => ({
								...prev,
								folder: event.target.value || undefined,
							}),
						})
					}
					className="rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
				>
					<option value="">All folders</option>
					{folders.data.map((f) => (
						<option key={f.folder} value={f.folder}>
							{f.folder} ({f.count})
						</option>
					))}
				</select>

				<input
					type="search"
					defaultValue={search.search ?? ""}
					placeholder="Search title or URL"
					onChange={(event) =>
						navigate({
							search: (prev) => ({
								...prev,
								search: event.target.value || undefined,
							}),
						})
					}
					className="rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
				/>

				<select
					value={search.sort ?? "created_desc"}
					onChange={(event) =>
						navigate({
							search: (prev) => ({
								...prev,
								sort: event.target.value as typeof search.sort,
							}),
						})
					}
					className="rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
				>
					<option value="created_desc">Newest first</option>
					<option value="created_asc">Oldest first</option>
					<option value="title_asc">Title A-Z</option>
					<option value="price_asc">Price low to high</option>
					<option value="price_desc">Price high to low</option>
				</select>

				<span className="text-slate-500">{items.data.length} items</span>
			</div>

			{items.data.length === 0 ? (
				<p className="text-slate-500">
					Nothing tracked yet. Paste a product URL above.
				</p>
			) : (
				<div className="grid gap-3">
					{items.data.map((item) => (
						<ItemCard key={item.id} item={item} />
					))}
				</div>
			)}
		</div>
	);
}
