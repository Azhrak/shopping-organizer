import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { AppLayout } from "~/components/AppShell";
import { Sparkline } from "~/components/Sparkline";
import { formatEur, formatPercentMagnitude } from "~/lib/money";
import { groupQuery } from "~/lib/queries";
import type { GroupDetail } from "~/lib/services/queries.service";

export const Route = createFileRoute("/compare/$groupId")({
	loader: async ({ context, params }) => {
		await context.queryClient.ensureQueryData(groupQuery(params.groupId));
	},
	component: ComparisonPage,
});

type GroupItem = GroupDetail["items"][number];

/**
 * Where the current price sits between the item's cheapest and dearest
 * observed price, as a 0-1 fraction. This is what makes the design's little
 * range meter meaningful: 0 means "at its all-time low".
 */
function rangePosition(item: GroupItem): number | null {
	const { current, lowestEver, highestEver } = item.stats;

	if (current === null || lowestEver === null || highestEver === null) {
		return null;
	}

	const span = highestEver - lowestEver;
	if (span <= 0) {
		return 0;
	}

	return Math.min(1, Math.max(0, (current - lowestEver) / span));
}

function ComparisonPage() {
	const { groupId } = Route.useParams();
	const { data: group } = useSuspenseQuery(groupQuery(groupId));

	// "Best deal" is the item furthest below its OWN typical price — never the
	// lowest sticker price, which would just favour the cheapest product.
	const bestDealId = group.items.reduce<{ id: string; pct: number } | null>(
		(best, item) => {
			const pct = item.stats.percentVsTypical;
			if (pct === null || pct >= 0) return best;
			if (!best || pct < best.pct) return { id: item.id, pct };
			return best;
		},
		null,
	)?.id;

	const cheapestId = group.items.reduce<{ id: string; price: number } | null>(
		(cheapest, item) => {
			const price = item.stats.current;
			if (price === null) return cheapest;
			if (!cheapest || price < cheapest.price) return { id: item.id, price };
			return cheapest;
		},
		null,
	)?.id;

	return (
		<AppLayout>
			<section>
				<Link
					to="/compare"
					className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-accent"
				>
					<i className="ph ph-arrow-left" aria-hidden="true" />
					All comparisons
				</Link>

				<div className="mb-4">
					<h3 className="text-[25px] text-text">{group.name}</h3>
					<div className="mt-1 text-[12.5px] text-muted">
						{group.items.length} {group.items.length === 1 ? "item" : "items"} ·
						compared on what each one usually costs, not just today's sticker
					</div>
				</div>

				<div
					data-grid="compare"
					className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 xl:grid-cols-4"
				>
					{group.items.map((item) => (
						<CompareCard
							key={item.id}
							item={item}
							isBestDeal={item.id === bestDealId}
							isCheapest={item.id === cheapestId && item.id !== bestDealId}
						/>
					))}
				</div>

				<p className="mt-6 text-xs text-faint">
					Each item is compared against its own 90-day typical price, so the
					percentages stay meaningful across products at different price points.
				</p>
			</section>
		</AppLayout>
	);
}

function CompareCard({
	item,
	isBestDeal,
	isCheapest,
}: {
	item: GroupItem;
	isBestDeal: boolean;
	isCheapest: boolean;
}) {
	const { stats } = item;
	const position = rangePosition(item);
	const cheaperThanTypical =
		stats.percentVsTypical !== null && stats.percentVsTypical < 0;

	const ring = isBestDeal
		? "shadow-[0_0_0_1px_var(--color-good),0_6px_18px_rgba(0,0,0,0.25)]"
		: isCheapest
			? "shadow-[0_0_0_1px_var(--color-accent),0_6px_18px_rgba(0,0,0,0.25)]"
			: "shadow-card";

	return (
		<article
			className={`relative flex flex-col gap-3 rounded-lg bg-surface p-3 ${ring}`}
		>
			{isBestDeal ? (
				<span className="absolute -top-2 left-3 inline-flex items-center gap-1.5 rounded-[5px] bg-good-deep px-2.5 py-0.5 text-[11px] font-medium text-good-text">
					<i className="ph ph-trend-down" aria-hidden="true" />
					Best deal vs its own usual
				</span>
			) : null}
			{isCheapest ? (
				<span className="absolute -top-2 left-3 inline-flex items-center gap-1.5 rounded-[5px] bg-accent-deep px-2.5 py-0.5 text-[11px] font-medium text-accent-on-deep">
					<i className="ph ph-tag" aria-hidden="true" />
					Cheapest right now
				</span>
			) : null}

			<div className="mt-1.5 grid aspect-[4/3] place-items-center overflow-hidden rounded-md">
				{item.image ? (
					<img src={item.image} alt="" className="size-full object-contain" />
				) : (
					<div className="stripe-placeholder size-full" />
				)}
			</div>

			<div>
				<div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted">
					<span className="grid size-3.5 flex-none place-items-center rounded bg-chip text-[8.5px] text-chip-text">
						{item.storeHostname.charAt(0).toUpperCase()}
					</span>
					<span className="truncate">{item.storeHostname}</span>
				</div>
				<div className="text-sm leading-[1.3] text-pretty text-text">
					{item.title ?? item.url}
				</div>
			</div>

			<div>
				<div className="text-[26px] font-semibold tracking-[-0.03em] text-text">
					{stats.current !== null ? formatEur(stats.current) : "—"}
				</div>
				{item.previousPrice !== null &&
				stats.current !== null &&
				item.previousPrice > stats.current ? (
					<div className="mt-0.5 text-[11.5px] text-faint">
						was {formatEur(item.previousPrice)}
					</div>
				) : null}
			</div>

			<div
				className={[
					"rounded-md p-2",
					cheaperThanTypical ? "bg-good-tint" : "bg-surface-2",
				].join(" ")}
			>
				<div
					className={[
						"text-[10px] uppercase tracking-[0.08em]",
						cheaperThanTypical ? "text-good-text opacity-85" : "text-faint",
					].join(" ")}
				>
					vs its own usual
				</div>
				<div
					className={[
						"mt-0.5 text-[19px]",
						cheaperThanTypical ? "text-good-text" : "text-text",
					].join(" ")}
				>
					{stats.percentVsTypical === null
						? "Not enough history"
						: // Rounding to whole percent means anything under 0.5% displays
							// as "0 % above", which reads as a non-statement. Say what it
							// actually means instead.
							Math.abs(stats.percentVsTypical) < 0.5
							? "At its usual price"
							: `${formatPercentMagnitude(stats.percentVsTypical, 0)} ${
									stats.percentVsTypical < 0 ? "below" : "above"
								}`}
				</div>

				{position !== null ? (
					<>
						<div className="relative mt-1.5 h-4">
							<div className="absolute inset-x-0 top-[7px] h-0.5 bg-hair" />
							<div
								className={[
									"absolute top-0.5 h-3 w-0.5",
									cheaperThanTypical ? "bg-good" : "bg-text",
								].join(" ")}
								style={{ left: `${Math.round(position * 100)}%` }}
							/>
						</div>
						<div className="flex justify-between font-mono text-[10px] text-faint">
							<span>
								{stats.lowestEver !== null ? formatEur(stats.lowestEver) : "—"}
							</span>
							<span>
								usual{" "}
								{stats.medianWindow !== null
									? formatEur(stats.medianWindow)
									: "—"}
							</span>
							<span>
								{stats.highestEver !== null
									? formatEur(stats.highestEver)
									: "—"}
							</span>
						</div>
					</>
				) : null}
			</div>

			<Sparkline
				prices={item.history.map((h) => h.price).reverse()}
				width={200}
				height={48}
				className="w-full"
			/>

			<div className="flex flex-col gap-1.5 text-[12.5px]">
				<Row
					label="Lowest ever"
					value={stats.lowestEver !== null ? formatEur(stats.lowestEver) : "—"}
				/>
				<Row
					label="Typical (90 d)"
					value={
						stats.medianWindow !== null ? formatEur(stats.medianWindow) : "—"
					}
				/>
				<Row
					label="Your target"
					value={item.targetPrice !== null ? formatEur(item.targetPrice) : "—"}
					accent
				/>
			</div>

			<Link
				to="/items/$itemId"
				params={{ itemId: item.id }}
				className="grid h-[34px] place-items-center rounded-lg border border-accent text-[13px] text-accent hover:bg-accent-tint"
			>
				Open details
			</Link>
		</article>
	);
}

function Row({
	label,
	value,
	accent,
}: {
	label: string;
	value: string;
	accent?: boolean;
}) {
	return (
		<div className="flex justify-between">
			<span className="text-muted">{label}</span>
			<span className={accent ? "text-accent" : "text-text"}>{value}</span>
		</div>
	);
}
