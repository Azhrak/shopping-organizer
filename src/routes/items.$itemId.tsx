import {
	useMutation,
	useQueryClient,
	useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { DiscountBadge } from "~/components/ItemCard";
import { formatEur } from "~/lib/money";
import { itemQuery, queryKeys } from "~/lib/queries";
import { checkItemNowFn, updateItemFn } from "~/lib/server/items";

export const Route = createFileRoute("/items/$itemId")({
	loader: async ({ context, params }) => {
		await context.queryClient.ensureQueryData(itemQuery(params.itemId));
	},
	component: ItemDetailPage,
});

function ItemDetailPage() {
	const { itemId } = Route.useParams();
	const queryClient = useQueryClient();
	const { data: item } = useSuspenseQuery(itemQuery(itemId));

	// Target price is edited in euros but stored in minor units.
	const [target, setTarget] = useState(
		item.targetPrice !== null ? (item.targetPrice / 100).toFixed(2) : "",
	);
	const [notes, setNotes] = useState(item.notes ?? "");

	const invalidate = async () => {
		await queryClient.invalidateQueries({ queryKey: queryKeys.item(itemId) });
		await queryClient.invalidateQueries({ queryKey: queryKeys.items });
	};

	const update = useMutation({
		mutationFn: updateItemFn,
		// Optimistic: write the new value into the cache immediately, and roll
		// back to the snapshot if the server rejects it.
		onMutate: async (variables) => {
			await queryClient.cancelQueries({ queryKey: queryKeys.item(itemId) });
			const previous = queryClient.getQueryData(queryKeys.item(itemId));

			queryClient.setQueryData(queryKeys.item(itemId), (old: typeof item) =>
				old
					? {
							...old,
							targetPrice:
								variables.data.targetPrice !== undefined
									? variables.data.targetPrice
									: old.targetPrice,
							notes:
								variables.data.notes !== undefined
									? variables.data.notes
									: old.notes,
						}
					: old,
			);

			return { previous };
		},
		onError: (_error, _variables, context) => {
			if (context?.previous) {
				queryClient.setQueryData(queryKeys.item(itemId), context.previous);
			}
		},
		onSettled: invalidate,
	});

	const checkNow = useMutation({
		mutationFn: () => checkItemNowFn({ data: { itemId } }),
		onSuccess: invalidate,
	});

	const saveTarget = () => {
		const trimmed = target.trim();

		if (trimmed === "") {
			update.mutate({ data: { itemId, targetPrice: null } });
			return;
		}

		const euros = Number(trimmed.replace(",", "."));
		if (!Number.isFinite(euros) || euros <= 0) {
			return;
		}

		update.mutate({
			data: { itemId, targetPrice: Math.round(euros * 100) },
		});
	};

	return (
		<div className="space-y-6">
			<div className="flex items-start gap-4">
				{item.image && (
					<img
						src={item.image}
						alt=""
						className="h-28 w-28 rounded object-contain"
					/>
				)}
				<div className="min-w-0 flex-1">
					<h1 className="text-xl font-semibold">{item.title ?? item.url}</h1>
					<a
						href={item.url}
						target="_blank"
						rel="noreferrer"
						className="text-sm text-blue-600 underline"
					>
						{item.storeHostname}
					</a>

					{item.extractFailing && (
						<p className="mt-2 rounded bg-amber-100 px-3 py-2 text-sm text-amber-900 dark:bg-amber-900 dark:text-amber-100">
							Not currently tracking — {item.consecutiveFailures} consecutive
							extraction failures.
						</p>
					)}
				</div>
			</div>

			<section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
				<Stat
					label="Current"
					value={
						item.stats.current !== null ? formatEur(item.stats.current) : "—"
					}
				/>
				<Stat
					label="Lowest ever"
					value={
						item.stats.lowestEver !== null
							? formatEur(item.stats.lowestEver)
							: "—"
					}
				/>
				<Stat
					label="90-day median"
					value={
						item.stats.medianWindow !== null
							? formatEur(item.stats.medianWindow)
							: "—"
					}
				/>
				<div>
					<div className="text-xs uppercase text-slate-500">vs typical</div>
					<div className="mt-1">
						<DiscountBadge percent={item.stats.percentVsTypical} />
					</div>
				</div>
			</section>

			<section className="flex flex-wrap items-end gap-3">
				<label className="text-sm">
					<span className="block text-slate-500">Target price (€)</span>
					<input
						value={target}
						onChange={(event) => setTarget(event.target.value)}
						onBlur={saveTarget}
						inputMode="decimal"
						className="mt-1 w-32 rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
					/>
				</label>

				<button
					type="button"
					onClick={() => checkNow.mutate()}
					disabled={checkNow.isPending}
					className="rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-slate-700"
				>
					{checkNow.isPending ? "Checking…" : "Check now"}
				</button>

				{checkNow.data?.isDrop && (
					<span className="text-sm text-emerald-600">
						Price drop ({checkNow.data.dropReason})
					</span>
				)}
				{checkNow.data?.ok === false && (
					<span className="text-sm text-rose-600">{checkNow.data.error}</span>
				)}
			</section>

			<section>
				<label className="text-sm">
					<span className="block text-slate-500">Notes</span>
					<textarea
						value={notes}
						onChange={(event) => setNotes(event.target.value)}
						onBlur={() =>
							update.mutate({ data: { itemId, notes: notes || null } })
						}
						rows={3}
						className="mt-1 w-full rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
					/>
				</label>
			</section>

			<section>
				<h2 className="mb-2 font-medium">
					Price history ({item.history.length})
				</h2>
				{item.history.length === 0 ? (
					<p className="text-sm text-slate-500">No price recorded yet.</p>
				) : (
					<table className="w-full text-sm">
						<thead className="text-left text-slate-500">
							<tr>
								<th className="py-1">Checked</th>
								<th className="py-1">Price</th>
								<th className="py-1">Availability</th>
							</tr>
						</thead>
						<tbody>
							{item.history.map((h) => (
								<tr
									key={h.checkedAt.toISOString()}
									className="border-t border-slate-200 dark:border-slate-800"
								>
									<td className="py-1">
										{h.checkedAt.toISOString().slice(0, 16).replace("T", " ")}
									</td>
									<td className="py-1">{formatEur(h.price)}</td>
									<td className="py-1 text-slate-500">{h.availability}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</section>
		</div>
	);
}

function Stat({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<div className="text-xs uppercase text-slate-500">{label}</div>
			<div className="mt-1 text-lg font-semibold">{value}</div>
		</div>
	);
}
