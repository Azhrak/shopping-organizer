import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Sparkline } from "./Sparkline";

/**
 * The projection maths is the part worth testing: a flat series divides by a
 * zero range, and a one-point series has no segment to draw. Both would render
 * NaN coordinates if handled naively, which produces an invisible line rather
 * than a crash — exactly the sort of silent wrongness worth a test.
 */

function pointsOf(markup: string): Array<[number, number]> {
	const match = /points="([^"]*)"/.exec(markup);
	if (!match?.[1]) {
		return [];
	}
	return match[1]
		.trim()
		.split(/\s+/)
		.map((pair) => {
			const [x, y] = pair.split(",").map(Number);
			return [x as number, y as number];
		});
}

describe("Sparkline", () => {
	it("renders no polyline for an empty series", () => {
		const markup = renderToStaticMarkup(<Sparkline prices={[]} />);

		expect(markup).not.toContain("<polyline");
	});

	it("renders no polyline for a single observation", () => {
		const markup = renderToStaticMarkup(<Sparkline prices={[1000]} />);

		expect(markup).not.toContain("<polyline");
	});

	it("spans the full width, inset by the stroke padding", () => {
		const width = 72;
		const markup = renderToStaticMarkup(
			<Sparkline prices={[100, 200, 300]} width={width} />,
		);
		const points = pointsOf(markup);

		// Both ends are inset by the 2px pad so the stroke is not half-clipped
		// at the horizontal bounds.
		expect(points).toHaveLength(3);
		expect(points[0]?.[0]).toBe(2);
		expect(points.at(-1)?.[0]).toBe(width - 2);
	});

	it("keeps every x coordinate inside the viewBox", () => {
		const width = 72;
		const markup = renderToStaticMarkup(
			<Sparkline prices={[5, 900, 40, 12]} width={width} />,
		);

		for (const [x] of pointsOf(markup)) {
			expect(x).toBeGreaterThanOrEqual(0);
			expect(x).toBeLessThanOrEqual(width);
		}
	});

	it("puts the lowest price below the highest on screen", () => {
		// SVG y grows downward, so a cheaper price must have a LARGER y.
		const markup = renderToStaticMarkup(<Sparkline prices={[300, 100]} />);
		const [first, second] = pointsOf(markup);

		expect(second?.[1]).toBeGreaterThan(first?.[1] as number);
	});

	it("centres a flat series instead of emitting NaN", () => {
		const markup = renderToStaticMarkup(
			<Sparkline prices={[500, 500, 500]} height={20} />,
		);
		const points = pointsOf(markup);

		expect(markup).not.toContain("NaN");
		for (const [, y] of points) {
			expect(y).toBe(10);
		}
	});

	it("never emits NaN for any coordinate", () => {
		const markup = renderToStaticMarkup(
			<Sparkline prices={[0, 0, 1, 99999, 4]} />,
		);

		expect(markup).not.toContain("NaN");
	});

	it("uses the good colour when the series trends down", () => {
		const markup = renderToStaticMarkup(<Sparkline prices={[300, 100]} />);

		expect(markup).toContain("var(--color-good)");
	});

	it("uses a neutral colour when the series trends up", () => {
		const markup = renderToStaticMarkup(<Sparkline prices={[100, 300]} />);

		expect(markup).toContain("var(--color-faint)");
	});

	it("honours an explicit colour override", () => {
		const markup = renderToStaticMarkup(
			<Sparkline prices={[300, 100]} color="var(--color-accent)" />,
		);

		expect(markup).toContain("var(--color-accent)");
	});

	it("keeps every point inside the viewBox", () => {
		const height = 20;
		const markup = renderToStaticMarkup(
			<Sparkline prices={[10, 500, 250, 900, 1]} height={height} />,
		);

		for (const [, y] of pointsOf(markup)) {
			expect(y).toBeGreaterThanOrEqual(0);
			expect(y).toBeLessThanOrEqual(height);
		}
	});
});
