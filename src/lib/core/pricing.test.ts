import { describe, expect, it } from "vitest";
import {
	computeStats,
	evaluateDrop,
	median,
	nextCheckDelayHours,
	type PricePoint,
	trailingWindowStart,
} from "./pricing";

const NOW = new Date("2026-08-03T12:00:00.000Z");

function daysAgo(days: number): Date {
	return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

function point(price: number, days: number): PricePoint {
	return { price, checkedAt: daysAgo(days) };
}

describe("evaluateDrop", () => {
	const base = {
		newPrice: 9000,
		previousPrice: 10000,
		targetPrice: null,
		trailingLow: null,
		lastAlertPrice: null,
	};

	describe("requires a fall against the previous check", () => {
		it("never fires on the first-ever check", () => {
			// No previous price means nothing has fallen, even if the price is
			// far below target.
			expect(
				evaluateDrop({ ...base, previousPrice: null, targetPrice: 100000 }),
			).toEqual({ isDrop: false, reason: null });
		});

		it("does not fire when the price rose", () => {
			expect(
				evaluateDrop({
					...base,
					newPrice: 11000,
					previousPrice: 10000,
					targetPrice: 100000,
				}),
			).toEqual({ isDrop: false, reason: null });
		});

		it("does not fire when the price is unchanged", () => {
			expect(
				evaluateDrop({
					...base,
					newPrice: 10000,
					previousPrice: 10000,
					targetPrice: 100000,
				}),
			).toEqual({ isDrop: false, reason: null });
		});
	});

	describe("target price", () => {
		it("fires when the new price reaches the target exactly", () => {
			// At-or-below: hitting the target you set is the event you asked for.
			expect(
				evaluateDrop({ ...base, newPrice: 9000, targetPrice: 9000 }),
			).toEqual({ isDrop: true, reason: "target" });
		});

		it("fires when the new price is below the target", () => {
			expect(
				evaluateDrop({ ...base, newPrice: 8500, targetPrice: 9000 }),
			).toEqual({ isDrop: true, reason: "target" });
		});

		it("does not fire on a fall that stays above the target", () => {
			expect(
				evaluateDrop({
					...base,
					newPrice: 9500,
					previousPrice: 10000,
					targetPrice: 9000,
				}),
			).toEqual({ isDrop: false, reason: null });
		});

		it("reports target as the reason when both conditions hold", () => {
			expect(
				evaluateDrop({
					...base,
					newPrice: 8000,
					targetPrice: 9000,
					trailingLow: 8500,
				}),
			).toEqual({ isDrop: true, reason: "target" });
		});
	});

	describe("trailing low", () => {
		it("fires when the price undercuts the trailing low", () => {
			expect(
				evaluateDrop({ ...base, newPrice: 8000, trailingLow: 8500 }),
			).toEqual({ isDrop: true, reason: "trailing-low" });
		});

		it("does not fire when merely matching the trailing low", () => {
			// Strictly below, not equal: matching a price already seen in the
			// window is not news.
			expect(
				evaluateDrop({ ...base, newPrice: 8500, trailingLow: 8500 }),
			).toEqual({ isDrop: false, reason: null });
		});

		it("does not fire on a fall that stays above the trailing low", () => {
			expect(
				evaluateDrop({
					...base,
					newPrice: 9500,
					previousPrice: 10000,
					trailingLow: 8500,
				}),
			).toEqual({ isDrop: false, reason: null });
		});
	});

	describe("no criteria available", () => {
		it("does not fire on a fall with neither target nor trailing low", () => {
			// A price that merely fell, with no baseline to judge it against,
			// is not an alert-worthy event.
			expect(evaluateDrop(base)).toEqual({ isDrop: false, reason: null });
		});
	});

	describe("dedupe against the last alerted price", () => {
		it("does not alert twice at the same price level", () => {
			expect(
				evaluateDrop({
					...base,
					newPrice: 9000,
					previousPrice: 10000,
					targetPrice: 9500,
					lastAlertPrice: 9000,
				}),
			).toEqual({ isDrop: false, reason: null });
		});

		it("does not alert on a rebound-then-redrop to the same level", () => {
			// Alerted at 9000, price went back to 10000, now 9000 again.
			expect(
				evaluateDrop({
					...base,
					newPrice: 9000,
					previousPrice: 10000,
					targetPrice: 9500,
					lastAlertPrice: 9000,
				}),
			).toEqual({ isDrop: false, reason: null });
		});

		it("still alerts on a genuine further drop below the alerted level", () => {
			expect(
				evaluateDrop({
					...base,
					newPrice: 8500,
					previousPrice: 9000,
					targetPrice: 9500,
					lastAlertPrice: 9000,
				}),
			).toEqual({ isDrop: true, reason: "target" });
		});

		it("does not alert when above the alerted level even if below target", () => {
			expect(
				evaluateDrop({
					...base,
					newPrice: 9200,
					previousPrice: 9800,
					targetPrice: 9500,
					lastAlertPrice: 9000,
				}),
			).toEqual({ isDrop: false, reason: null });
		});

		it("dedupe applies to trailing-low drops too", () => {
			expect(
				evaluateDrop({
					...base,
					newPrice: 8000,
					previousPrice: 9000,
					trailingLow: 8500,
					lastAlertPrice: 8000,
				}),
			).toEqual({ isDrop: false, reason: null });
		});
	});

	describe("full oscillation sequence", () => {
		it("alerts only on genuinely new lows across a price series", () => {
			// Simulates repeated checks, threading lastAlertPrice forward the
			// way the service layer does. This is the scenario the dedupe rule
			// exists for: a price bouncing around a level must alert once.
			const series = [10000, 9000, 10000, 9000, 8500, 9000, 8500, 8000];
			const target = 9500;

			let lastAlertPrice: number | null = null;
			let previousPrice: number | null = null;
			const alertedAt: Array<number> = [];

			for (const price of series) {
				const result = evaluateDrop({
					newPrice: price,
					previousPrice,
					targetPrice: target,
					trailingLow: null,
					lastAlertPrice,
				});

				if (result.isDrop) {
					alertedAt.push(price);
					lastAlertPrice = price;
				}
				previousPrice = price;
			}

			// 9000 alerts once (not on its second visit), then each new low.
			expect(alertedAt).toEqual([9000, 8500, 8000]);
		});
	});
});

describe("median", () => {
	it("returns null for an empty list", () => {
		expect(median([])).toBeNull();
	});

	it("returns the single value for one element", () => {
		expect(median([1000])).toBe(1000);
	});

	it("returns the middle value for an odd count", () => {
		expect(median([3000, 1000, 2000])).toBe(2000);
	});

	it("averages the two middle values for an even count", () => {
		expect(median([1000, 2000, 3000, 4000])).toBe(2500);
	});

	it("rounds a fractional average to a whole cent", () => {
		// (1000 + 1001) / 2 = 1000.5 -> 1001, still an integer minor unit.
		expect(median([1000, 1001])).toBe(1001);
	});

	it("does not mutate its input", () => {
		const input = [3000, 1000, 2000];
		median(input);
		expect(input).toEqual([3000, 1000, 2000]);
	});

	it("handles duplicates", () => {
		expect(median([1000, 1000, 1000, 5000])).toBe(1000);
	});
});

describe("computeStats", () => {
	it("returns all-null stats for an item with no history", () => {
		expect(computeStats([], NOW)).toEqual({
			current: null,
			lowestEver: null,
			highestEver: null,
			medianWindow: null,
			lowestWindow: null,
			percentVsTypical: null,
			windowSampleCount: 0,
			totalSampleCount: 0,
		});
	});

	it("takes current from the latest checkedAt, not input order", () => {
		// Deliberately unsorted, with the newest point in the middle.
		const points = [point(9000, 30), point(7000, 1), point(8000, 10)];
		expect(computeStats(points, NOW).current).toBe(7000);
	});

	it("computes lowest and highest across all history", () => {
		const points = [point(9000, 200), point(7000, 1), point(12000, 100)];
		const stats = computeStats(points, NOW);
		expect(stats.lowestEver).toBe(7000);
		expect(stats.highestEver).toBe(12000);
	});

	it("excludes points outside the trailing window from the median", () => {
		// The 100-day-old 50000 must not drag the median; only the recent
		// points count toward "typical".
		const points = [
			point(50000, 100),
			point(10000, 10),
			point(10000, 5),
			point(10000, 1),
		];
		const stats = computeStats(points, NOW);

		expect(stats.medianWindow).toBe(10000);
		expect(stats.windowSampleCount).toBe(3);
		expect(stats.totalSampleCount).toBe(4);
		// lowestEver still spans all of history.
		expect(stats.lowestEver).toBe(10000);
		expect(stats.highestEver).toBe(50000);
	});

	it("includes a point exactly on the window boundary", () => {
		const points = [point(10000, 90), point(8000, 1)];
		const stats = computeStats(points, NOW);
		expect(stats.windowSampleCount).toBe(2);
	});

	it("excludes a point just outside the window boundary", () => {
		const points = [point(10000, 91), point(8000, 1)];
		const stats = computeStats(points, NOW);
		expect(stats.windowSampleCount).toBe(1);
	});

	describe("percentVsTypical", () => {
		it("is negative when the current price is below typical", () => {
			// median of [10000, 10000, 8000] = 10000; current 8000 is -20%.
			const points = [point(10000, 30), point(10000, 20), point(8000, 1)];
			expect(computeStats(points, NOW).percentVsTypical).toBeCloseTo(-20, 10);
		});

		it("is positive when the current price is above typical", () => {
			const points = [point(10000, 30), point(10000, 20), point(12000, 1)];
			expect(computeStats(points, NOW).percentVsTypical).toBeCloseTo(20, 10);
		});

		it("is exactly zero when the current price equals the median", () => {
			const points = [point(10000, 30), point(10000, 20), point(10000, 1)];
			expect(computeStats(points, NOW).percentVsTypical).toBe(0);
		});

		it("compares against the window median, not the all-time median", () => {
			// All-time median would be 50000 (pulled up by old points) and give
			// -80%. The window median is 10000, giving -20%. Getting this wrong
			// yields a plausible-looking but badly wrong comparison figure.
			const points = [
				point(50000, 200),
				point(50000, 150),
				point(50000, 100),
				point(10000, 30),
				point(10000, 20),
				point(8000, 1),
			];
			const stats = computeStats(points, NOW);

			expect(stats.medianWindow).toBe(10000);
			expect(stats.percentVsTypical).toBeCloseTo(-20, 10);
		});

		it("is null when the only sample is outside the window", () => {
			// There is a current price, but nothing recent to call typical.
			const points = [point(10000, 200)];
			const stats = computeStats(points, NOW);

			expect(stats.current).toBe(10000);
			expect(stats.medianWindow).toBeNull();
			expect(stats.percentVsTypical).toBeNull();
		});

		it("is zero for a single in-window check, which is its own typical", () => {
			const points = [point(10000, 1)];
			expect(computeStats(points, NOW).percentVsTypical).toBe(0);
		});

		it("is null rather than Infinity when the median is zero", () => {
			// A free item has no meaningful percentage-vs-typical.
			const points = [point(0, 10), point(0, 5), point(500, 1)];
			const stats = computeStats(points, NOW);

			expect(stats.medianWindow).toBe(0);
			expect(stats.percentVsTypical).toBeNull();
		});

		it("handles a halving as exactly -50%", () => {
			const points = [point(20000, 30), point(20000, 20), point(10000, 1)];
			expect(computeStats(points, NOW).percentVsTypical).toBeCloseTo(-50, 10);
		});

		it("handles a doubling as exactly +100%", () => {
			const points = [point(10000, 30), point(10000, 20), point(20000, 1)];
			expect(computeStats(points, NOW).percentVsTypical).toBeCloseTo(100, 10);
		});

		it("stays precise for prices that are awkward in binary floating point", () => {
			// 1999 cents against a median of 2999 cents.
			const points = [point(2999, 30), point(2999, 20), point(1999, 1)];
			const stats = computeStats(points, NOW);
			expect(stats.percentVsTypical).toBeCloseTo(-33.3444481, 6);
		});

		it("is comparable across items with very different absolute prices", () => {
			// The whole point of the metric: a 20% discount reads as -20
			// whether the item costs 10 EUR or 1000 EUR.
			const cheap = [point(1000, 30), point(1000, 20), point(800, 1)];
			const pricey = [point(100000, 30), point(100000, 20), point(80000, 1)];

			const cheapPct = computeStats(cheap, NOW).percentVsTypical;
			const priceyPct = computeStats(pricey, NOW).percentVsTypical;

			expect(cheapPct).toBeCloseTo(-20, 10);
			expect(priceyPct).toBeCloseTo(-20, 10);
			expect(cheapPct).toBeCloseTo(priceyPct as number, 10);
		});
	});

	it("reports lowestWindow separately from lowestEver", () => {
		const points = [point(5000, 200), point(9000, 10), point(8000, 1)];
		const stats = computeStats(points, NOW);

		expect(stats.lowestEver).toBe(5000);
		expect(stats.lowestWindow).toBe(8000);
	});

	it("respects a custom window length", () => {
		const points = [point(10000, 20), point(8000, 1)];
		const stats = computeStats(points, NOW, 7);

		expect(stats.windowSampleCount).toBe(1);
		expect(stats.medianWindow).toBe(8000);
	});
});

describe("trailingWindowStart", () => {
	it("is exactly 90 days before now by default", () => {
		const start = trailingWindowStart(NOW);
		expect(NOW.getTime() - start.getTime()).toBe(90 * 24 * 60 * 60 * 1000);
	});
});

describe("nextCheckDelayHours", () => {
	it("uses the base interval for a healthy item", () => {
		expect(nextCheckDelayHours(0, 6, 168)).toBe(6);
	});

	it("treats a negative failure count as healthy", () => {
		expect(nextCheckDelayHours(-1, 6, 168)).toBe(6);
	});

	it("doubles the interval per consecutive failure", () => {
		expect(nextCheckDelayHours(1, 6, 168)).toBe(12);
		expect(nextCheckDelayHours(2, 6, 168)).toBe(24);
		expect(nextCheckDelayHours(3, 6, 168)).toBe(48);
	});

	it("caps at the maximum interval", () => {
		expect(nextCheckDelayHours(10, 6, 168)).toBe(168);
	});

	it("does not overflow for an absurd failure count", () => {
		const delay = nextCheckDelayHours(100000, 6, 168);
		expect(Number.isFinite(delay)).toBe(true);
		expect(delay).toBe(168);
	});
});
