/**
 * Small inline price trend line for catalog cards and rows.
 *
 * Isomorphic and dependency-free: the points are projected here rather than by
 * a charting library, because the whole shape is nine coordinates and pulling
 * in a chart runtime for it would cost more than the feature.
 */

export interface SparklineProps {
	/** Prices in minor units, oldest first. */
	prices: ReadonlyArray<number>;
	width?: number;
	height?: number;
	/** Stroke colour; defaults to the "good" token when trending down. */
	color?: string;
	className?: string;
}

export function Sparkline({
	prices,
	width = 72,
	height = 20,
	color,
	className,
}: SparklineProps) {
	// One point cannot describe a trend, and zero points cannot be drawn at all.
	if (prices.length < 2) {
		return (
			<svg
				viewBox={`0 0 ${width} ${height}`}
				width={width}
				height={height}
				className={className}
				aria-hidden="true"
			/>
		);
	}

	const min = Math.min(...prices);
	const max = Math.max(...prices);
	const span = max - min;

	// Inset both axes so the stroke is never half-clipped at the extremes: the
	// cheapest and dearest points sit exactly on the vertical bounds, and the
	// first and last points sit exactly on the horizontal ones.
	const pad = 2;
	const usable = height - pad * 2;
	const usableWidth = width - pad * 2;

	const points = prices
		.map((price, index) => {
			const x = pad + (index / (prices.length - 1)) * usableWidth;
			// A flat series has no range to normalise against — centre it.
			const y =
				span === 0
					? height / 2
					: pad + usable - ((price - min) / span) * usable;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		})
		.join(" ");

	const trendingDown = (prices.at(-1) as number) < (prices[0] as number);
	const stroke =
		color ?? (trendingDown ? "var(--color-good)" : "var(--color-faint)");

	return (
		<svg
			viewBox={`0 0 ${width} ${height}`}
			width={width}
			height={height}
			// "none" lets the line fill a stretched container (the comparison card
			// scales it to full width). The vertical inset above is what keeps the
			// stroke from clipping once stretched.
			preserveAspectRatio="none"
			className={className}
			aria-hidden="true"
			// A non-uniform scale would otherwise thin the stroke horizontally.
			vectorEffect="non-scaling-stroke"
		>
			<polyline
				points={points}
				fill="none"
				stroke={stroke}
				strokeWidth={1.4}
				strokeLinejoin="round"
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}
