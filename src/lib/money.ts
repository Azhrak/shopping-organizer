/**
 * Money handling. Prices live in the database as integer minor units (cents)
 * and are only converted at the edges: parsing an extractor result on the way
 * in, formatting for the UI on the way out.
 *
 * This module is isomorphic — it is imported by both server services and
 * client components, so it must not import anything server-only.
 */

/**
 * Convert a major-unit amount (1299.00) to integer minor units (129900).
 *
 * Returns null when the input is not a finite number or would not round-trip
 * as a safe integer, so a malformed extractor result can never be silently
 * stored as a wrong price.
 *
 * Uses a string round-trip rather than Math.round(value * 100) because binary
 * floating point makes the naive form wrong for common prices: 19.99 * 100 is
 * 1998.9999999999998, and 1.005 * 100 is 100.49999999999999.
 */
export function toMinorUnits(value: number): number | null {
	if (!Number.isFinite(value)) {
		return null;
	}

	// toFixed rounds the actual stored binary value to 2 decimals, which avoids
	// the artefacts above. Note that a literal like 1.005 is really
	// 1.00499999999999989 in binary, so it rounds DOWN to 1.00 — correct for
	// the value that exists, even though the source text suggests otherwise.
	// Exact .xx5 midpoints are not representable, so there is no true tie to
	// break here.
	const rounded = Number(value.toFixed(2));
	const minor = Math.round(rounded * 100);

	if (!Number.isSafeInteger(minor)) {
		return null;
	}

	return minor;
}

/**
 * Convert integer minor units back to major units. Used only for formatting.
 */
export function toMajorUnits(minor: number): number {
	return minor / 100;
}

const FI_EUR = new Intl.NumberFormat("fi-FI", {
	style: "currency",
	currency: "EUR",
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
});

/**
 * Format integer minor units as European EUR: 129900 -> "1 299,00 €".
 *
 * Note the separators produced by the fi-FI locale are a non-breaking space
 * (U+00A0) for thousands and a narrow no-break space (U+202F) before the
 * currency symbol, not plain ASCII spaces.
 */
export function formatEur(minor: number): string {
	return FI_EUR.format(toMajorUnits(minor));
}

/**
 * Format a signed percentage for display: -12.5 -> "-12,5 %".
 */
export function formatPercent(value: number, fractionDigits = 1): string {
	return new Intl.NumberFormat("fi-FI", {
		style: "percent",
		minimumFractionDigits: fractionDigits,
		maximumFractionDigits: fractionDigits,
		signDisplay: "exceptZero",
	}).format(value / 100);
}

/**
 * Format a percentage magnitude, without a sign: -12.5 -> "12,5 %".
 *
 * For labels that state the direction in words ("18 % below its usual
 * price"). Passing an absolute value to formatPercent would still print a
 * leading "+", producing "+18 % below" — a sign that contradicts the sentence
 * around it.
 */
export function formatPercentMagnitude(
	value: number,
	fractionDigits = 1,
): string {
	return new Intl.NumberFormat("fi-FI", {
		style: "percent",
		minimumFractionDigits: fractionDigits,
		maximumFractionDigits: fractionDigits,
		signDisplay: "never",
	}).format(Math.abs(value) / 100);
}
