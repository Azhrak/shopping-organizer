import { Link } from "@tanstack/react-router";

import { formatEur, formatPercent } from "~/lib/money";
import type { ItemListEntry } from "~/lib/services/queries.service";

/**
 * Formats a percent-vs-typical figure with a colour cue. Negative (cheaper
 * than its own typical price) is the interesting case.
 */
export function DiscountBadge({ percent }: { percent: number | null }) {
	if (percent === null) {
		return null;
	}

	const tone =
		percent <= -10
			? "bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100"
			: percent >= 10
				? "bg-rose-100 text-rose-900 dark:bg-rose-900 dark:text-rose-100"
				: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300";

	return (
		<span className={`rounded px-2 py-0.5 text-xs font-medium ${tone}`}>
			{formatPercent(percent)} vs typical
		</span>
	);
}

export function ItemCard({ item }: { item: ItemListEntry }) {
	return (
		<Link
			to="/items/$itemId"
			params={{ itemId: item.id }}
			className="flex gap-4 rounded-lg border border-slate-200 p-4 hover:border-slate-400 dark:border-slate-800 dark:hover:border-slate-600"
		>
			{item.image ? (
				<img
					src={item.image}
					alt=""
					className="h-20 w-20 shrink-0 rounded object-contain"
				/>
			) : (
				<div className="h-20 w-20 shrink-0 rounded bg-slate-100 dark:bg-slate-800" />
			)}

			<div className="min-w-0 flex-1">
				<div className="truncate font-medium">{item.title ?? item.url}</div>
				<div className="text-sm text-slate-500">{item.storeHostname}</div>

				<div className="mt-2 flex flex-wrap items-center gap-2">
					{item.currentPrice !== null ? (
						<span className="text-lg font-semibold">
							{formatEur(item.currentPrice)}
						</span>
					) : (
						<span className="text-sm text-slate-500">No price yet</span>
					)}

					{item.targetPrice !== null && (
						<span className="text-xs text-slate-500">
							target {formatEur(item.targetPrice)}
						</span>
					)}

					{item.extractFailing && (
						<span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-900 dark:text-amber-100">
							not tracking ({item.consecutiveFailures} fails)
						</span>
					)}

					{item.availability === "out_of_stock" && (
						<span className="text-xs text-slate-500">out of stock</span>
					)}
				</div>
			</div>
		</Link>
	);
}
