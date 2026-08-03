/**
 * Pure price analysis. No database, no I/O, no framework imports — every
 * function here is a total function over its inputs, which is what makes the
 * drop logic and the percent-vs-typical figure exhaustively testable.
 *
 * All prices are integer minor units (cents).
 */

export const TRAILING_WINDOW_DAYS = 90;

export interface PricePoint {
	price: number;
	checkedAt: Date;
}

export interface DropInput {
	/** The price just extracted. */
	newPrice: number;
	/** Price of the immediately preceding check, or null if this is the first. */
	previousPrice: number | null;
	/** User's target price, or null if unset. */
	targetPrice: number | null;
	/** Lowest price seen in the trailing window, or null if no history. */
	trailingLow: number | null;
	/** Price at which we last alerted, or null if never alerted. */
	lastAlertPrice: number | null;
}

export type DropReason = "target" | "trailing-low";

export interface DropResult {
	isDrop: boolean;
	reason: DropReason | null;
}

/**
 * Decide whether a new price constitutes a drop event worth alerting on.
 *
 * Fires when ALL of the following hold:
 *   1. The price fell relative to the previous check. A first-ever check is
 *      never a drop — there is nothing to have fallen from.
 *   2. It is below the target price (if one is set), OR below the trailing
 *      90-day low. Target takes precedence in the reported reason.
 *   3. It is strictly below the price we last alerted at. This is the dedupe:
 *      a price oscillating between 90 and 100 alerts once at 90, and again
 *      only if it goes below 90.
 *
 * Condition 3 deliberately compares against the last ALERTED price rather
 * than tracking "already alerted" as a boolean, so a genuine further drop
 * still notifies while a re-drop to the same level does not.
 */
export function evaluateDrop(input: DropInput): DropResult {
	const { newPrice, previousPrice, targetPrice, trailingLow, lastAlertPrice } =
		input;

	const noDrop: DropResult = { isDrop: false, reason: null };

	// 1. Must have fallen against the previous observation.
	if (previousPrice === null || newPrice >= previousPrice) {
		return noDrop;
	}

	// 3. Dedupe against the level we last alerted at.
	if (lastAlertPrice !== null && newPrice >= lastAlertPrice) {
		return noDrop;
	}

	// 2. Must clear the target, or beat the trailing low.
	if (targetPrice !== null && newPrice <= targetPrice) {
		return { isDrop: true, reason: "target" };
	}

	if (trailingLow !== null && newPrice < trailingLow) {
		return { isDrop: true, reason: "trailing-low" };
	}

	return noDrop;
}

/**
 * Median of a list of prices. Returns null for an empty list.
 *
 * For an even count this averages the two middle values and rounds to the
 * nearest whole cent (half away from zero), so the result stays an integer in
 * minor units like every other price in the system.
 */
export function median(prices: ReadonlyArray<number>): number | null {
	if (prices.length === 0) {
		return null;
	}

	const sorted = [...prices].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);

	if (sorted.length % 2 === 1) {
		return sorted[mid];
	}

	const avg = (sorted[mid - 1] + sorted[mid]) / 2;
	return Math.round(avg);
}

/**
 * Filter points to those at or after `windowStart`.
 */
export function withinWindow(
	points: ReadonlyArray<PricePoint>,
	windowStart: Date,
): Array<PricePoint> {
	return points.filter((p) => p.checkedAt.getTime() >= windowStart.getTime());
}

/**
 * Start of the trailing window ending at `now`.
 */
export function trailingWindowStart(
	now: Date,
	days: number = TRAILING_WINDOW_DAYS,
): Date {
	return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export interface ItemStats {
	/** Most recent price, or null if the item has never been checked. */
	current: number | null;
	/** Lowest price ever recorded. */
	lowestEver: number | null;
	/** Highest price ever recorded. */
	highestEver: number | null;
	/** Median price over the trailing window, or null if the window is empty. */
	medianWindow: number | null;
	/** Lowest price within the trailing window. */
	lowestWindow: number | null;
	/**
	 * Current price relative to this item's own typical (trailing-window
	 * median), as a signed percentage. Negative means cheaper than typical.
	 *
	 * -20 means "20% below its own typical price". Null when there is no
	 * current price or no median to compare against.
	 */
	percentVsTypical: number | null;
	/** Number of price checks in the trailing window. */
	windowSampleCount: number;
	/** Total number of price checks on record. */
	totalSampleCount: number;
}

/**
 * Compute an item's statistics from its full price history.
 *
 * `points` may be in any order; this does not assume sorting. The "current"
 * price is the one with the latest checkedAt, with ties broken by taking the
 * last occurrence in input order.
 *
 * percentVsTypical is the figure that powers the comparison view. It is
 * computed against the item's OWN trailing median, never against another
 * item — comparing absolute prices across different products is meaningless,
 * but "this is 20% below its normal price" is comparable across products.
 */
export function computeStats(
	points: ReadonlyArray<PricePoint>,
	now: Date,
	windowDays: number = TRAILING_WINDOW_DAYS,
): ItemStats {
	if (points.length === 0) {
		return {
			current: null,
			lowestEver: null,
			highestEver: null,
			medianWindow: null,
			lowestWindow: null,
			percentVsTypical: null,
			windowSampleCount: 0,
			totalSampleCount: 0,
		};
	}

	let latest = points[0];
	for (const p of points) {
		if (p.checkedAt.getTime() >= latest.checkedAt.getTime()) {
			latest = p;
		}
	}

	const allPrices = points.map((p) => p.price);
	const windowPoints = withinWindow(
		points,
		trailingWindowStart(now, windowDays),
	);
	const windowPrices = windowPoints.map((p) => p.price);

	const medianWindow = median(windowPrices);
	const current = latest.price;

	// Guard against a zero median: a free item has no meaningful "typical"
	// percentage and dividing would yield Infinity.
	const percentVsTypical =
		medianWindow !== null && medianWindow !== 0
			? ((current - medianWindow) / medianWindow) * 100
			: null;

	return {
		current,
		lowestEver: Math.min(...allPrices),
		highestEver: Math.max(...allPrices),
		medianWindow,
		lowestWindow: windowPrices.length > 0 ? Math.min(...windowPrices) : null,
		percentVsTypical,
		windowSampleCount: windowPoints.length,
		totalSampleCount: points.length,
	};
}

/**
 * Backoff schedule for the next check of an item.
 *
 * A healthy item is checked every `baseIntervalHours`. Each consecutive
 * failure doubles the interval, capped at `maxIntervalHours`, so a URL that
 * 404s is retried daily rather than hourly instead of being hammered.
 */
export function nextCheckDelayHours(
	consecutiveFailures: number,
	baseIntervalHours: number,
	maxIntervalHours: number,
): number {
	if (consecutiveFailures <= 0) {
		return baseIntervalHours;
	}

	// Cap the exponent before computing the power so a large failure count
	// cannot overflow to Infinity.
	const exponent = Math.min(consecutiveFailures, 16);
	const delay = baseIntervalHours * 2 ** exponent;

	return Math.min(delay, maxIntervalHours);
}
