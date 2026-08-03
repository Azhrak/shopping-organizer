import { describe, expect, it } from "vitest";

import { projectHistory } from "./PriceChart";

/**
 * The projection is the part that can be plausibly wrong: a flat series
 * divides by a zero range, simultaneous timestamps divide by a zero span, and
 * a reference line outside the observed range would be drawn off-canvas. All
 * three render a chart that looks fine while showing the wrong thing.
 */

function at(daysAgo: number, price: number) {
	return {
		price,
		checkedAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
	};
}

function coordsOf(path: string): Array<[number, number]> {
	return [...path.matchAll(/[ML]([\d.]+),([\d.]+)/g)].map((m) => [
		Number(m[1]),
		Number(m[2]),
	]);
}

describe("projectHistory", () => {
	it("returns null for empty history", () => {
		expect(projectHistory([], 260)).toBeNull();
	});

	it("sorts unordered history chronologically", () => {
		const projection = projectHistory(
			[at(1, 100), at(10, 300), at(5, 200)],
			260,
		);
		const xs = coordsOf(projection?.path as string).map(([x]) => x);

		// x must increase monotonically once sorted by time.
		for (let i = 1; i < xs.length; i++) {
			expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1] as number);
		}
	});

	it("steps rather than interpolating between observations", () => {
		const projection = projectHistory([at(2, 100), at(1, 200)], 260);
		const coords = coordsOf(projection?.path as string);

		// M(start) then two L commands per subsequent point: hold, then jump.
		expect(coords).toHaveLength(3);
		// The hold shares the previous y value.
		expect(coords[1]?.[1]).toBe(coords[0]?.[1]);
		// The jump shares the new x value.
		expect(coords[2]?.[0]).toBe(coords[1]?.[0]);
	});

	it("draws a cheaper price lower on screen", () => {
		const projection = projectHistory([at(2, 300), at(1, 100)], 260);

		// SVG y grows downward: the cheap price gets the larger y.
		expect(projection?.yFor(100)).toBeGreaterThan(
			projection?.yFor(300) as number,
		);
	});

	it("marks a drop but not a rise", () => {
		const dropped = projectHistory([at(2, 300), at(1, 100)], 260);
		const rose = projectHistory([at(2, 100), at(1, 300)], 260);

		expect(dropped?.dropDots).toHaveLength(1);
		expect(rose?.dropDots).toHaveLength(0);
	});

	it("handles a flat series without emitting NaN", () => {
		const projection = projectHistory(
			[at(3, 500), at(2, 500), at(1, 500)],
			260,
		);

		expect(projection?.path).not.toContain("NaN");
		for (const [, y] of coordsOf(projection?.path as string)) {
			expect(Number.isFinite(y)).toBe(true);
		}
	});

	it("handles a single observation without NaN", () => {
		const projection = projectHistory([at(1, 500)], 260);

		expect(projection?.path).not.toContain("NaN");
		expect(projection?.lastPoint).not.toBeNull();
	});

	it("handles simultaneous timestamps without dividing by zero", () => {
		const now = new Date();
		const projection = projectHistory(
			[
				{ price: 100, checkedAt: now },
				{ price: 200, checkedAt: now },
				{ price: 150, checkedAt: now },
			],
			260,
		);

		expect(projection?.path).not.toContain("NaN");
		for (const [x, y] of coordsOf(projection?.path as string)) {
			expect(Number.isFinite(x)).toBe(true);
			expect(Number.isFinite(y)).toBe(true);
		}
	});

	it("keeps a target below the observed range inside the chart", () => {
		const height = 260;
		// Target far below every observed price.
		const projection = projectHistory([at(2, 900), at(1, 800)], height, [
			null,
			100,
		]);
		const y = projection?.yFor(100) as number;

		expect(y).toBeGreaterThanOrEqual(0);
		expect(y).toBeLessThanOrEqual(height);
	});

	it("keeps a median above the observed range inside the chart", () => {
		const height = 260;
		const projection = projectHistory([at(2, 100), at(1, 120)], height, [
			5000,
			null,
		]);
		const y = projection?.yFor(5000) as number;

		expect(y).toBeGreaterThanOrEqual(0);
		expect(y).toBeLessThanOrEqual(height);
	});

	it("keeps every plotted coordinate inside the viewBox", () => {
		const height = 260;
		const projection = projectHistory(
			[at(9, 100), at(7, 5000), at(4, 250), at(1, 3), at(0, 900)],
			height,
		);

		for (const [x, y] of coordsOf(projection?.path as string)) {
			expect(x).toBeGreaterThanOrEqual(0);
			expect(x).toBeLessThanOrEqual(1000);
			expect(y).toBeGreaterThanOrEqual(0);
			expect(y).toBeLessThanOrEqual(height);
		}
	});

	it("closes the area path back to the baseline", () => {
		const projection = projectHistory([at(2, 100), at(1, 200)], 260);

		expect(projection?.areaPath.endsWith("Z")).toBe(true);
		expect(projection?.areaPath).toContain("260");
	});
});
