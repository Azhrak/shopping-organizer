import { Link } from "@tanstack/react-router";

import { Sparkline } from "~/components/Sparkline";
import { formatEur, formatPercent } from "~/lib/money";
import type { ItemListEntry } from "~/lib/services/queries.service";

/**
 * Catalog item presentation, ported from design/Hintavahti.dc.html.
 *
 * Two shapes over the same data: a grid card and a dense row. Both are pure
 * presentation over ItemListEntry — prices arrive in minor units and are
 * formatted here at the edge.
 */

/** Store initial badge, e.g. "P" for Partioaitta. */
function StoreChip({ hostname }: { hostname: string }) {
	return (
		<span className="grid size-3.5 flex-none place-items-center rounded bg-chip text-[8.5px] text-chip-text">
			{hostname.charAt(0).toUpperCase()}
		</span>
	);
}

function StoreLine({ item }: { item: ItemListEntry }) {
	return (
		<div className="flex items-center gap-1.5 text-[11px] text-muted">
			<StoreChip hostname={item.storeHostname} />
			<span className="truncate">{item.storeHostname}</span>
		</div>
	);
}

/**
 * Percent-vs-typical badge. Negative means cheaper than this item's own
 * typical price, which is the case worth highlighting.
 */
export function DiscountBadge({ percent }: { percent: number | null }) {
	if (percent === null || percent >= 0) {
		return null;
	}

	return (
		<span className="rounded-[5px] bg-good-deep px-[7px] py-0.5 text-[11px] font-medium text-good-text">
			{formatPercent(percent, 0)}
		</span>
	);
}

function StockDot({ item }: { item: ItemListEntry }) {
	if (item.availability === "out_of_stock") {
		return (
			<span className="ml-auto inline-flex items-center gap-1 text-[11px] text-faint">
				<span className="size-[5px] rounded-full bg-faint" />
				Out of stock
			</span>
		);
	}

	if (item.availability !== "in_stock") {
		return null;
	}

	return (
		<span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted">
			<span className="size-[5px] rounded-full bg-good" />
			In stock
		</span>
	);
}

/**
 * Progress toward the user's target price.
 *
 * Fills relative to the gap between the item's typical price and its target,
 * so the bar answers "how close is this to the price I want" rather than
 * showing an arbitrary fraction.
 */
function TargetBar({ item }: { item: ItemListEntry }) {
	if (item.targetPrice === null || item.currentPrice === null) {
		return null;
	}

	const belowTarget = item.currentPrice <= item.targetPrice;
	const gap = item.currentPrice - item.targetPrice;

	// Anchor the empty end of the bar at the highest price we have seen in the
	// sparkline window, falling back to the current price when there is no
	// history to compare against.
	const ceiling = Math.max(item.currentPrice, ...item.sparkline);
	const range = ceiling - item.targetPrice;
	const rawProgress =
		range <= 0 ? 1 : Math.min(1, Math.max(0, 1 - gap / range));
	// Keep a sliver visible at zero. An item sitting at its highest observed
	// price computes to 0% and would render as an empty track, which reads as
	// "no target set" rather than "furthest it has been from your target".
	const progress = belowTarget ? 1 : Math.max(0.03, rawProgress);

	return (
		<div className="mt-auto pt-2">
			<div className="h-[3px] overflow-hidden rounded-sm bg-hair">
				<div
					className={belowTarget ? "h-full bg-good" : "h-full bg-accent"}
					style={{ width: `${Math.round(progress * 100)}%` }}
				/>
			</div>
			<div className="mt-1 flex justify-between text-[10.5px] text-faint">
				<span>Target {formatEur(item.targetPrice)}</span>
				{belowTarget ? (
					<span className="text-good-text">Below target</span>
				) : (
					<span>{formatEur(gap)} to go</span>
				)}
			</div>
		</div>
	);
}

function PriceLine({
	item,
	size,
}: {
	item: ItemListEntry;
	size: "card" | "row";
}) {
	const dim = item.availability === "out_of_stock";

	if (item.currentPrice === null) {
		return <span className="text-sm text-faint">No price yet</span>;
	}

	// Only show a struck-through previous price when it was actually higher —
	// showing it after a rise would read as a discount that never happened.
	const showPrevious =
		item.previousPrice !== null && item.previousPrice > item.currentPrice;

	return (
		<div className="flex items-baseline gap-1.5">
			<span
				className={[
					size === "card" ? "text-[19px]" : "text-[17px]",
					"font-semibold tracking-[-0.02em]",
					dim ? "text-muted" : "text-text",
				].join(" ")}
			>
				{formatEur(item.currentPrice)}
			</span>
			{showPrevious ? (
				<span className="text-xs text-faint line-through">
					{formatEur(item.previousPrice as number)}
				</span>
			) : null}
		</div>
	);
}

function ImageSlot({
	item,
	className,
}: {
	item: ItemListEntry;
	className: string;
}) {
	if (item.image) {
		return (
			<img
				src={item.image}
				alt=""
				loading="lazy"
				className={`${className} bg-surface-2 object-contain`}
			/>
		);
	}

	return <div className={`${className} stripe-placeholder`} />;
}

export function ItemCard({ item }: { item: ItemListEntry }) {
	return (
		<Link
			to="/items/$itemId"
			params={{ itemId: item.id }}
			className="flex flex-col overflow-hidden rounded-lg bg-surface shadow-card hover:shadow-card-hover"
		>
			<div className="relative aspect-[4/3]">
				<ImageSlot item={item} className="size-full" />
				<span className="absolute left-2 top-2">
					<DiscountBadge percent={item.percentVsTypical} />
				</span>
				{item.availability === "out_of_stock" ? (
					// color-mix rather than a /45 opacity shorthand: --color-bg is a
					// plain hex custom property, and the shorthand does not apply
					// alpha to it, so the overlay rendered fully transparent.
					<span className="absolute inset-0 bg-[color-mix(in_srgb,var(--color-bg)_45%,transparent)]" />
				) : null}
			</div>

			<div className="flex flex-1 flex-col gap-1.5 p-3">
				<StoreLine item={item} />
				<div className="text-[13.5px] leading-[1.3] text-pretty text-text">
					{item.title ?? item.url}
				</div>
				<PriceLine item={item} size="card" />

				<div className="flex items-center gap-2">
					<Sparkline prices={item.sparkline} />
					<span className="font-mono text-[10.5px] text-faint">90 d</span>
					<StockDot item={item} />
				</div>

				{item.extractFailing ? (
					<span className="rounded bg-[color-mix(in_srgb,var(--color-faint)_25%,transparent)] px-2 py-0.5 text-[11px] text-muted">
						Not tracking · {item.consecutiveFailures} failed checks
					</span>
				) : item.priceSelectorFailing ? (
					// Only when extraction itself is fine: a stale pick still yields a
					// price via the generic cascade, so "not tracking" would be a lie.
					<span className="rounded bg-[color-mix(in_srgb,var(--color-faint)_25%,transparent)] px-2 py-0.5 text-[11px] text-muted">
						Picked price no longer found
					</span>
				) : null}

				<TargetBar item={item} />
			</div>
		</Link>
	);
}

export function ItemRow({ item }: { item: ItemListEntry }) {
	return (
		<Link
			to="/items/$itemId"
			params={{ itemId: item.id }}
			className="grid grid-cols-[56px_minmax(0,1fr)_auto] items-center gap-4 rounded-lg bg-surface p-3 shadow-card hover:shadow-card-hover md:grid-cols-[56px_minmax(0,1fr)_130px_90px_168px_150px]"
		>
			<ImageSlot item={item} className="h-11 w-14 rounded-md" />

			<div className="min-w-0">
				<div className="truncate text-sm leading-[1.25] text-text">
					{item.title ?? item.url}
				</div>
				<div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
					<StoreChip hostname={item.storeHostname} />
					<span className="truncate">{item.storeHostname}</span>
					{item.availability === "out_of_stock" ? (
						<>
							<span className="text-faint">·</span>
							<span className="text-faint">Out of stock</span>
						</>
					) : null}
				</div>
			</div>

			<div className="flex justify-end md:block">
				<PriceLine item={item} size="row" />
			</div>

			<div className="hidden justify-end md:flex">
				<DiscountBadge percent={item.percentVsTypical} />
			</div>

			<div className="hidden items-center gap-2 md:flex">
				<Sparkline prices={item.sparkline} />
				<span className="font-mono text-[10.5px] text-faint">90 d</span>
			</div>

			<div className="hidden md:block">
				<TargetBar item={item} />
			</div>
		</Link>
	);
}
