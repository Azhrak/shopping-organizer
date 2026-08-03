import { describe, expect, it } from "vitest";
import { formatEur, formatPercent, toMajorUnits, toMinorUnits } from "./money";

describe("toMinorUnits", () => {
	it("converts a whole-euro amount", () => {
		expect(toMinorUnits(1299)).toBe(129900);
	});

	it("converts an amount with cents", () => {
		expect(toMinorUnits(1299.0)).toBe(129900);
		expect(toMinorUnits(12.34)).toBe(1234);
	});

	it("handles amounts that are inexact in binary floating point", () => {
		// The naive Math.round(v * 100) is correct here by luck, but these are
		// the classic cases where float arithmetic misleads:
		// 19.99 * 100 === 1998.9999999999998
		expect(toMinorUnits(19.99)).toBe(1999);
		expect(toMinorUnits(0.29)).toBe(29);
	});

	it("rounds by the stored binary value, not the written decimal", () => {
		// A literal like 1.005 is stored as 1.00499999999999989, so rounding
		// DOWN is correct for the number that actually exists. There is no
		// representable .xx5 midpoint, so no tie-breaking rule applies.
		expect(toMinorUnits(1.005)).toBe(100);
		expect(toMinorUnits(8.165)).toBe(816);
		expect(toMinorUnits(10.235)).toBe(1023);

		// Values that are unambiguously above or below the midpoint round the
		// way you would expect regardless.
		expect(toMinorUnits(10.234)).toBe(1023);
		expect(toMinorUnits(10.236)).toBe(1024);
		expect(toMinorUnits(10.2351)).toBe(1024);
	});

	it("handles zero", () => {
		expect(toMinorUnits(0)).toBe(0);
	});

	it("returns null for non-finite input", () => {
		expect(toMinorUnits(Number.NaN)).toBeNull();
		expect(toMinorUnits(Number.POSITIVE_INFINITY)).toBeNull();
		expect(toMinorUnits(Number.NEGATIVE_INFINITY)).toBeNull();
	});

	it("returns null for an amount too large to be a safe integer", () => {
		expect(toMinorUnits(Number.MAX_SAFE_INTEGER)).toBeNull();
	});

	it("round-trips through toMajorUnits", () => {
		for (const value of [0, 1, 19.99, 1299.0, 0.05]) {
			const minor = toMinorUnits(value);
			expect(minor).not.toBeNull();
			expect(toMajorUnits(minor as number)).toBeCloseTo(value, 10);
		}
	});
});

describe("formatEur", () => {
	// fi-FI uses U+00A0 as the thousands separator and U+202F before the
	// currency symbol. Normalise both to plain spaces so these assertions stay
	// readable; the formatter output itself is left as the locale intends.
	function normalise(s: string): string {
		return s.replace(/[  ]/g, " ");
	}

	it("formats thousands with a space and decimals with a comma", () => {
		expect(normalise(formatEur(129900))).toBe("1 299,00 €");
	});

	it("formats an amount below a thousand", () => {
		expect(normalise(formatEur(1999))).toBe("19,99 €");
	});

	it("always shows two decimal places", () => {
		expect(normalise(formatEur(1000))).toBe("10,00 €");
	});

	it("formats zero", () => {
		expect(normalise(formatEur(0))).toBe("0,00 €");
	});

	it("formats millions", () => {
		expect(normalise(formatEur(123456789))).toBe("1 234 567,89 €");
	});

	it("uses a non-breaking space, never an ASCII space", () => {
		// Guards against a future refactor quietly switching locale.
		expect(formatEur(129900)).toContain(" ");
	});
});

describe("formatPercent", () => {
	// fi-FI emits U+2212 MINUS SIGN rather than an ASCII hyphen, plus the same
	// no-break spaces as above.
	function normalise(s: string): string {
		return s.replace(/[  ]/g, " ").replace(/−/g, "-");
	}

	it("shows a minus sign for a discount", () => {
		expect(normalise(formatPercent(-20))).toBe("-20,0 %");
	});

	it("shows an explicit plus sign for an increase", () => {
		expect(normalise(formatPercent(20))).toBe("+20,0 %");
	});

	it("shows no sign for zero", () => {
		expect(normalise(formatPercent(0))).toBe("0,0 %");
	});

	it("respects a custom precision", () => {
		expect(normalise(formatPercent(-33.3444, 2))).toBe("-33,34 %");
	});

	it("emits a real minus sign, not an ASCII hyphen", () => {
		expect(formatPercent(-20)).toContain("−");
		expect(formatPercent(-20)).not.toContain("-");
	});
});
