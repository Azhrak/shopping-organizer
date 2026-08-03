/**
 * Stepped price history chart, ported from design/Hintavahti.dc.html.
 *
 * A price holds its value until the next observation, so the line steps rather
 * than interpolating — a diagonal between two checks would draw prices that
 * were never listed.
 *
 * Pure projection, no chart library: the inputs are a handful of points and
 * two reference lines.
 */

export interface PriceChartPoint {
	price: number;
	checkedAt: Date;
}

export interface PriceChartProps {
	/** History in any order; sorted internally. */
	history: ReadonlyArray<PriceChartPoint>;
	/** Dashed reference line for the item's typical price. */
	medianPrice?: number | null;
	/** Dashed reference line for the user's target. */
	targetPrice?: number | null;
	height?: number;
}

const VIEW_WIDTH = 1000;

interface Projection {
	path: string;
	areaPath: string;
	dropDots: Array<{ x: number; y: number }>;
	lastPoint: { x: number; y: number } | null;
	yFor: (price: number) => number;
	min: number;
	max: number;
}

/**
 * Project history into viewBox coordinates.
 *
 * Exported for testing: the scaling is where an off-by-one or a divide-by-zero
 * silently produces a chart that looks plausible but is wrong.
 */
export function projectHistory(
	history: ReadonlyArray<PriceChartPoint>,
	height: number,
	references: Array<number | null | undefined> = [],
): Projection | null {
	if (history.length === 0) {
		return null;
	}

	const sorted = [...history].sort(
		(a, b) => a.checkedAt.getTime() - b.checkedAt.getTime(),
	);

	const prices = sorted.map((p) => p.price);
	// Reference lines must fit inside the plot too, or a target far below the
	// observed range would be drawn outside the chart.
	const considered = [
		...prices,
		...references.filter((v): v is number => typeof v === "number"),
	];

	const rawMin = Math.min(...considered);
	const rawMax = Math.max(...considered);
	// Pad a flat series so it renders as a centred line rather than collapsing
	// onto a single row of pixels.
	const flat = rawMax === rawMin;
	const min = flat ? rawMin - 1 : rawMin;
	const max = flat ? rawMax + 1 : rawMax;

	const padY = 12;
	const usable = height - padY * 2;
	const yFor = (price: number) =>
		padY + usable - ((price - min) / (max - min)) * usable;

	const firstTime = sorted[0]?.checkedAt.getTime() as number;
	const lastTime = sorted.at(-1)?.checkedAt.getTime() as number;
	const timeSpan = lastTime - firstTime;
	// All checks at the same instant have no span to spread across; lay them out
	// evenly by index instead of dividing by zero.
	const xFor = (point: PriceChartPoint, index: number) =>
		timeSpan === 0
			? sorted.length === 1
				? VIEW_WIDTH
				: (index / (sorted.length - 1)) * VIEW_WIDTH
			: ((point.checkedAt.getTime() - firstTime) / timeSpan) * VIEW_WIDTH;

	const segments: Array<string> = [];
	const dropDots: Array<{ x: number; y: number }> = [];

	sorted.forEach((point, index) => {
		const x = xFor(point, index);
		const y = yFor(point.price);

		if (index === 0) {
			segments.push(`M${x.toFixed(1)},${y.toFixed(1)}`);
			return;
		}

		// Step: hold the previous price up to this observation's time, then jump.
		const previousY = yFor(sorted[index - 1]?.price as number);
		segments.push(`L${x.toFixed(1)},${previousY.toFixed(1)}`);
		segments.push(`L${x.toFixed(1)},${y.toFixed(1)}`);

		if (point.price < (sorted[index - 1]?.price as number)) {
			dropDots.push({ x, y });
		}
	});

	const path = segments.join(" ");
	const lastX = xFor(sorted.at(-1) as PriceChartPoint, sorted.length - 1);

	return {
		path,
		areaPath: `${path} L${lastX.toFixed(1)},${height} L${(xFor(sorted[0] as PriceChartPoint, 0)).toFixed(1)},${height} Z`,
		dropDots,
		lastPoint: {
			x: lastX,
			y: yFor(sorted.at(-1)?.price as number),
		},
		yFor,
		min,
		max,
	};
}

export function PriceChart({
	history,
	medianPrice,
	targetPrice,
	height = 260,
}: PriceChartProps) {
	const projection = projectHistory(history, height, [
		medianPrice,
		targetPrice,
	]);

	if (!projection) {
		return (
			<p className="py-8 text-center text-sm text-faint">
				No price recorded yet.
			</p>
		);
	}

	const gridLines = [0.1, 0.35, 0.6, 0.85].map((f) => height * f);

	return (
		<svg
			viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
			width="100%"
			height={height}
			preserveAspectRatio="none"
			className="block overflow-visible"
			role="img"
			aria-label="Price history"
		>
			{gridLines.map((y) => (
				<line
					key={y}
					x1={0}
					y1={y}
					x2={VIEW_WIDTH}
					y2={y}
					stroke="var(--color-hair)"
					strokeWidth={1}
				/>
			))}

			{typeof medianPrice === "number" ? (
				<line
					x1={0}
					y1={projection.yFor(medianPrice)}
					x2={VIEW_WIDTH}
					y2={projection.yFor(medianPrice)}
					stroke="var(--color-muted)"
					strokeWidth={1}
					strokeDasharray="3 5"
					opacity={0.7}
				/>
			) : null}

			{typeof targetPrice === "number" ? (
				<line
					x1={0}
					y1={projection.yFor(targetPrice)}
					x2={VIEW_WIDTH}
					y2={projection.yFor(targetPrice)}
					stroke="var(--color-accent)"
					strokeWidth={1}
					strokeDasharray="4 4"
				/>
			) : null}

			<path d={projection.areaPath} fill="var(--color-accent)" opacity={0.1} />
			<path
				d={projection.path}
				fill="none"
				stroke="var(--color-accent)"
				strokeWidth={2}
			/>

			{projection.dropDots.map((dot) => (
				<circle
					key={`${dot.x}-${dot.y}`}
					cx={dot.x}
					cy={dot.y}
					r={4}
					fill="var(--color-good)"
				/>
			))}

			{projection.lastPoint ? (
				<circle
					cx={projection.lastPoint.x}
					cy={projection.lastPoint.y}
					r={4}
					fill="var(--color-bg)"
					stroke="var(--color-accent)"
					strokeWidth={2.5}
				/>
			) : null}
		</svg>
	);
}
