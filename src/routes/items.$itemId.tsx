import {
	useMutation,
	useQueryClient,
	useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import { AppLayout } from "~/components/AppShell";
import { PriceChart } from "~/components/PriceChart";
import { formatEur, formatPercent, formatPercentMagnitude } from "~/lib/money";
import { itemQuery, queryKeys } from "~/lib/queries";
import { checkItemNowFn, updateItemFn } from "~/lib/server/items";

export const Route = createFileRoute("/items/$itemId")({
	loader: async ({ context, params }) => {
		await context.queryClient.ensureQueryData(itemQuery(params.itemId));
	},
	component: ItemDetailPage,
});

const dateFormat = new Intl.DateTimeFormat("fi-FI", {
	day: "numeric",
	month: "short",
	year: "numeric",
	timeZone: "UTC",
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
		await queryClient.invalidateQueries({ queryKey: queryKeys.smartCounts });
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

		// Accept the comma decimal separator Finnish users will type.
		const euros = Number(trimmed.replace(",", "."));
		if (!Number.isFinite(euros) || euros <= 0) {
			return;
		}

		update.mutate({ data: { itemId, targetPrice: Math.round(euros * 100) } });
	};

	const { stats } = item;
	const showPrevious =
		item.previousPrice !== null &&
		stats.current !== null &&
		item.previousPrice > stats.current;

	const gapToTarget =
		item.targetPrice !== null && stats.current !== null
			? stats.current - item.targetPrice
			: null;

	return (
		<AppLayout>
			<section>
				<Link
					to="/"
					className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-accent"
				>
					<i className="ph ph-arrow-left" aria-hidden="true" />
					All saved
				</Link>

				<div
					data-row="detail"
					className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]"
				>
					<div>
						{/*
						 * Without an image the 16:11 box is pure dead space, so it
						 * collapses to a short banner instead of dominating the page.
						 */}
						<div
							className={[
								"relative grid place-items-center overflow-hidden rounded-lg bg-surface shadow-card",
								item.image ? "aspect-[16/11]" : "h-32",
							].join(" ")}
						>
							{item.image ? (
								<img
									src={item.image}
									alt=""
									className="size-full object-contain"
								/>
							) : (
								<div className="stripe-placeholder grid size-full place-items-center">
									<span className="font-mono text-[11px] tracking-[0.04em] text-faint">
										no image
									</span>
								</div>
							)}
							{stats.percentVsTypical !== null && stats.percentVsTypical < 0 ? (
								<span className="absolute left-3 top-3 rounded-[5px] bg-good-deep px-2.5 py-1 text-xs font-medium text-good-text">
									{formatPercent(stats.percentVsTypical, 0)} vs typical
								</span>
							) : null}
						</div>
					</div>

					<div className="flex flex-col gap-4">
						<div>
							<a
								href={item.url}
								target="_blank"
								rel="noreferrer"
								className="mb-1.5 inline-flex items-center gap-1.5 text-xs text-muted hover:text-accent"
							>
								<span className="grid size-[15px] place-items-center rounded bg-chip text-[9px] text-chip-text">
									{item.storeHostname.charAt(0).toUpperCase()}
								</span>
								{item.storeHostname}
								<i
									className="ph ph-arrow-square-out text-xs text-faint"
									aria-hidden="true"
								/>
							</a>
							<h3 className="text-[25px] text-text">
								{item.title ?? item.url}
							</h3>
							<div className="mt-2 flex flex-wrap items-center gap-3 text-[12.5px] text-muted">
								<span className="inline-flex items-center gap-1.5">
									<span
										className={
											item.history[0]?.availability === "out_of_stock"
												? "size-1.5 rounded-full bg-faint"
												: "size-1.5 rounded-full bg-good"
										}
									/>
									{item.history[0]?.availability === "out_of_stock"
										? "Out of stock"
										: item.history[0]?.availability === "in_stock"
											? "In stock"
											: "Stock unknown"}
								</span>
								<span className="text-faint">·</span>
								<span>Watching since {dateFormat.format(item.createdAt)}</span>
							</div>
						</div>

						{item.extractFailing ? (
							<p className="rounded-lg bg-surface p-3 text-sm text-muted shadow-card">
								Not currently tracking — {item.consecutiveFailures} consecutive
								extraction failures. The saved URL is kept; checks back off
								until it works again.
							</p>
						) : null}

						{item.priceSelectorFailing ? (
							<p className="rounded-lg bg-surface p-3 text-sm text-muted shadow-card">
								The price you picked on this page is no longer found
								{item.priceSelector ? (
									<>
										{" — "}
										<code className="font-mono text-[12px]">
											{item.priceSelector}
										</code>
									</>
								) : null}
								. Prices are still being read the generic way, so tracking
								continues — but the store has most likely changed its layout,
								and picking the price again will be more reliable.
							</p>
						) : null}

						<div className="rounded-lg bg-surface p-4 shadow-card">
							<div className="flex items-baseline gap-2">
								<span className="text-[34px] font-semibold tracking-[-0.03em] text-text">
									{stats.current !== null ? formatEur(stats.current) : "—"}
								</span>
								{showPrevious ? (
									<span className="text-sm text-faint line-through">
										{formatEur(item.previousPrice as number)}
									</span>
								) : null}
							</div>

							{stats.percentVsTypical !== null ? (
								<div
									className={[
										"mt-2 inline-flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-xs",
										stats.percentVsTypical < 0
											? "bg-good-deep text-good-text"
											: "bg-surface-2 text-muted",
									].join(" ")}
								>
									<i
										className={
											stats.percentVsTypical < 0
												? "ph ph-trend-down"
												: "ph ph-trend-up"
										}
										aria-hidden="true"
									/>
									{Math.abs(stats.percentVsTypical) < 0.5
										? "At its usual price"
										: `${formatPercentMagnitude(stats.percentVsTypical, 0)} ${
												stats.percentVsTypical < 0 ? "below" : "above"
											} its usual price`}
								</div>
							) : null}

							<div className="my-4 h-px bg-hair" />

							<div className="grid grid-cols-3 gap-3">
								<Stat
									label="Lowest ever"
									value={
										stats.lowestEver !== null
											? formatEur(stats.lowestEver)
											: "—"
									}
								/>
								<Stat
									label="Typical (90 d)"
									value={
										stats.medianWindow !== null
											? formatEur(stats.medianWindow)
											: "—"
									}
									hint="median"
								/>
								<Stat
									label="Your target"
									value={
										item.targetPrice !== null
											? formatEur(item.targetPrice)
											: "—"
									}
									hint={
										gapToTarget !== null && gapToTarget > 0
											? `${formatEur(gapToTarget)} to go`
											: gapToTarget !== null
												? "Below target"
												: undefined
									}
									accent
								/>
							</div>
						</div>

						<div className="flex flex-col gap-3 rounded-lg bg-surface p-4 shadow-card">
							<div className="flex items-end gap-2">
								<div className="flex-1">
									<label
										htmlFor="target-price"
										className="mb-1 block text-xs text-muted"
									>
										Alert me under
									</label>
									<div className="flex h-9 items-center gap-1.5 rounded-lg border border-divider bg-surface-2 px-2.5">
										<input
											id="target-price"
											value={target}
											onChange={(event) => setTarget(event.target.value)}
											onBlur={saveTarget}
											inputMode="decimal"
											placeholder="199,00"
											className="min-w-0 flex-1 border-0 bg-transparent text-sm text-text outline-none placeholder:text-faint"
										/>
										<span className="text-[13px] text-faint">€</span>
									</div>
								</div>

								<button
									type="button"
									onClick={() => checkNow.mutate()}
									disabled={checkNow.isPending}
									className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-divider px-3 text-[13px] text-muted hover:border-accent hover:text-accent disabled:opacity-50"
								>
									<i className="ph ph-arrows-clockwise" aria-hidden="true" />
									{checkNow.isPending ? "Checking…" : "Check now"}
								</button>
							</div>
							<p className="text-[11.5px] text-faint">
								A target marks the price you are waiting for and drives the drop
								detection on scheduled checks.
							</p>

							{checkNow.data?.isDrop ? (
								<p className="text-[13px] text-good-text">
									Price drop detected ({checkNow.data.dropReason}).
								</p>
							) : null}
							{checkNow.data?.ok === false ? (
								<p className="text-[13px] text-muted">{checkNow.data.error}</p>
							) : null}
						</div>

						<div>
							<label htmlFor="notes" className="mb-1 block text-xs text-muted">
								Notes
							</label>
							<textarea
								id="notes"
								value={notes}
								onChange={(event) => setNotes(event.target.value)}
								onBlur={() =>
									update.mutate({ data: { itemId, notes: notes || null } })
								}
								className="min-h-[84px] w-full resize-y rounded-lg border border-divider bg-surface px-2.5 py-2 text-[13.5px] leading-[1.5] text-text outline-none"
							/>
						</div>
					</div>
				</div>

				<div className="mt-6 rounded-lg bg-surface p-4 shadow-card">
					<div className="mb-4 flex flex-wrap items-center gap-3">
						<h4 className="text-[17px] text-text">Price history</h4>
						<span className="text-xs text-faint">
							{item.storeHostname} · {item.history.length}{" "}
							{item.history.length === 1 ? "check" : "checks"} recorded
						</span>
					</div>

					<PriceChart
						history={item.history}
						medianPrice={stats.medianWindow}
						targetPrice={item.targetPrice}
					/>

					{item.history.length > 0 ? (
						<div className="mt-2 flex flex-wrap items-center gap-4 text-[11.5px] text-muted">
							<span className="inline-flex items-center gap-1.5">
								<span className="h-0.5 w-4 bg-accent" />
								Listed price
							</span>
							{stats.medianWindow !== null ? (
								<span className="inline-flex items-center gap-1.5">
									<span className="w-4 border-t border-dashed border-muted" />
									Typical {formatEur(stats.medianWindow)}
								</span>
							) : null}
							{item.targetPrice !== null ? (
								<span className="inline-flex items-center gap-1.5">
									<span className="w-4 border-t border-dashed border-accent" />
									Your target {formatEur(item.targetPrice)}
								</span>
							) : null}
							<span className="inline-flex items-center gap-1.5">
								<span className="size-[7px] rounded-full bg-good" />
								Price drop
							</span>
						</div>
					) : null}
				</div>
			</section>
		</AppLayout>
	);
}

function Stat({
	label,
	value,
	hint,
	accent,
}: {
	label: string;
	value: string;
	hint?: string;
	accent?: boolean;
}) {
	return (
		<div>
			<div className="text-[10px] uppercase tracking-[0.08em] text-faint">
				{label}
			</div>
			<div
				className={[
					"mt-0.5 text-[17px]",
					accent ? "text-accent" : "text-text",
				].join(" ")}
			>
				{value}
			</div>
			{hint ? <div className="text-[11px] text-faint">{hint}</div> : null}
		</div>
	);
}
