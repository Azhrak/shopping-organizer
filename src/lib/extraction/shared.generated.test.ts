import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generate, TARGET } from "../../../scripts/build-extension-shared";

/**
 * The extension ships a generated copy of deriveSelector and parsePriceString
 * because Chrome loads extension/ unpacked, with no build step and no way to
 * import from src/.
 *
 * A stale copy is a silent correctness bug of the worst kind here: the picker
 * would validate one selector while the server ran another, or the user would
 * see one price while a different one was recorded. So staleness is a test
 * failure, not a lint warning.
 */
describe("extension/shared.generated.js", () => {
	it("is up to date with the TypeScript sources", () => {
		const onDisk = readFileSync(TARGET, "utf8");

		expect(
			onDisk,
			"extension/shared.generated.js is stale — run: pnpm build:extension",
		).toBe(generate());
	});

	it("is syntactically valid JavaScript", () => {
		const source = readFileSync(TARGET, "utf8").replace(/^export /gm, "");

		// Chrome will not report a parse error usefully — it simply refuses to
		// inject the script — so catch it here instead.
		expect(() => new Function(source)).not.toThrow();
	});

	it("exports the functions the picker depends on", () => {
		const source = readFileSync(TARGET, "utf8");

		expect(source).toMatch(/export function deriveSelector\(/);
		expect(source).toMatch(/export function parsePriceString\(/);
		expect(source).toMatch(/export function validates\(/);
	});

	it("carries no import statements", () => {
		// A generated file that imports anything cannot load as an extension
		// module in an injected context.
		const source = readFileSync(TARGET, "utf8");

		expect(source).not.toMatch(/^import /m);
		expect(source).not.toMatch(/require\(/);
	});

	it("lives where the manifest expects it", () => {
		expect(path.basename(TARGET)).toBe("shared.generated.js");
	});
});

/**
 * Behavioural equivalence: the generated copy must agree with the TypeScript
 * implementation, not merely resemble it. These run the generated source and
 * compare its answers against the same inputs the TS suites use.
 */
describe("generated parsePriceString matches the source implementation", () => {
	async function loadGenerated() {
		const source = readFileSync(TARGET, "utf8");
		const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
		return (await import(/* @vite-ignore */ dataUrl)) as {
			parsePriceString: (raw: string | number | null) => number | null;
			deriveSelector: (root: unknown, element: unknown) => string | null;
		};
	}

	it("agrees on every case the source suite covers", async () => {
		const generated = await loadGenerated();
		const { parsePriceString } = await import("./parse");

		const cases: Array<string | number | null> = [
			"1299.00",
			"19,99",
			"1.299,00",
			"1,299.00",
			"1.234.567,89",
			"1 299,00 €",
			"€19.99",
			"1.299",
			"12,5",
			"1.2345",
			"12,3456",
			"1.29.00",
			"",
			"Ota yhteyttä",
			"0",
			"-19,99",
			1299,
			19.99,
			Number.NaN,
			null,
		];

		for (const input of cases) {
			expect(
				generated.parsePriceString(input),
				`disagreement on ${JSON.stringify(input)}`,
			).toBe(parsePriceString(input));
		}
	});
});
