import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { DiscountBadge } from "~/components/ItemCard";
import { formatEur } from "~/lib/money";
import { groupQuery } from "~/lib/queries";

export const Route = createFileRoute("/compare/$groupId")({
	loader: async ({ context, params }) => {
		await context.queryClient.ensureQueryData(groupQuery(params.groupId));
	},
	component: ComparisonPage,
});

function ComparisonPage() {
	const { groupId } = Route.useParams();
	const { data: group } = useSuspenseQuery(groupQuery(groupId));

	return (
		<div className="space-y-6">
			<h1 className="text-xl font-semibold">{group.name}</h1>

			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
				{group.items.map((item) => (
					<div
						key={item.id}
						className="rounded-lg border border-slate-200 p-4 dark:border-slate-800"
					>
						{item.image && (
							<img
								src={item.image}
								alt=""
								className="mb-3 h-24 w-full rounded object-contain"
							/>
						)}

						<Link
							to="/items/$itemId"
							params={{ itemId: item.id }}
							className="line-clamp-2 font-medium underline"
						>
							{item.title ?? item.url}
						</Link>
						<div className="text-sm text-slate-500">{item.storeHostname}</div>

						<div className="mt-3 space-y-1 text-sm">
							<Row
								label="Current"
								value={
									item.stats.current !== null
										? formatEur(item.stats.current)
										: "—"
								}
							/>
							<Row
								label="Lowest ever"
								value={
									item.stats.lowestEver !== null
										? formatEur(item.stats.lowestEver)
										: "—"
								}
							/>
							<Row
								label="90-day median"
								value={
									item.stats.medianWindow !== null
										? formatEur(item.stats.medianWindow)
										: "—"
								}
							/>
						</div>

						<div className="mt-3">
							<DiscountBadge percent={item.stats.percentVsTypical} />
						</div>
					</div>
				))}
			</div>

			<p className="text-sm text-slate-500">
				Each item is compared against its own 90-day typical price, so the
				percentages are meaningful across products at different price points.
			</p>
		</div>
	);
}

function Row({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex justify-between">
			<span className="text-slate-500">{label}</span>
			<span>{value}</span>
		</div>
	);
}
