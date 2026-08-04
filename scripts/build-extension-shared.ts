/**
 * Generate extension/shared.generated.js from the TypeScript sources.
 *
 * The extension is loaded unpacked by Chrome with no build step, so it cannot
 * import from src/. Two pieces of logic must nonetheless be identical on both
 * sides:
 *
 *   - `deriveSelector` — the picker derives the selector, the server stores and
 *     later runs it. A disagreement means the server queries something the
 *     picker never validated.
 *   - `parsePriceString` — the picker parses the element's text into MAJOR
 *     units before sending. A disagreement means the number the user saw and
 *     the number recorded are not the same, which is the one failure this
 *     project treats as worse than no price at all.
 *
 * Hand-copying them would drift. This transpiles them with the TypeScript
 * compiler instead, and `shared.generated.test.ts` fails if the checked-in copy
 * is stale — so drift is caught by the normal test run rather than discovered
 * later as a wrong price.
 *
 * The compiler is used rather than regex type-stripping deliberately: an early
 * regex version silently deleted a `try {` while removing an adjacent type
 * annotation, producing a file that still looked plausible. A mistranslation
 * here writes wrong prices, so this step must be exact rather than clever.
 *
 * Run: pnpm build:extension
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

export const TARGET = path.join(root, "extension/shared.generated.js");

const HEADER = `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Produced by scripts/build-extension-shared.ts from:
 *   src/lib/extraction/deriveSelector.ts
 *   src/lib/extraction/parse.ts  (parsePriceString only)
 *
 * Regenerate with: pnpm build:extension
 * shared.generated.test.ts fails if this file is out of date, so the picker and
 * the server can never disagree about a selector or a parsed price.
 */
`;

/** Transpile TypeScript to ES2022 JavaScript, preserving everything else. */
function transpile(source: string, fileName: string): string {
	const result = ts.transpileModule(source, {
		fileName,
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			removeComments: false,
			newLine: ts.NewLineKind.LineFeed,
		},
		reportDiagnostics: true,
	});

	const fatal = (result.diagnostics ?? []).filter(
		(d) => d.category === ts.DiagnosticCategory.Error,
	);

	if (fatal.length > 0) {
		const messages = fatal
			.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "))
			.join("; ");
		throw new Error(`build-extension-shared: ${fileName}: ${messages}`);
	}

	return result.outputText;
}

/**
 * Isolate one exported function, with its docblock, from a source file.
 *
 * Uses the TypeScript AST rather than brace counting so a brace inside a string
 * or regex literal cannot truncate the extraction.
 */
function extractFunction(source: string, fileName: string, name: string): string {
	const sourceFile = ts.createSourceFile(
		fileName,
		source,
		ts.ScriptTarget.ES2022,
		true,
	);

	for (const statement of sourceFile.statements) {
		if (
			ts.isFunctionDeclaration(statement) &&
			statement.name?.text === name
		) {
			// getFullStart() includes leading trivia, i.e. the docblock.
			return source.slice(statement.getFullStart(), statement.getEnd());
		}
	}

	throw new Error(`build-extension-shared: ${name} not found in ${fileName}`);
}

export function generate(): string {
	const derivePath = path.join(root, "src/lib/extraction/deriveSelector.ts");
	const parsePath = path.join(root, "src/lib/extraction/parse.ts");

	const deriveSource = readFileSync(derivePath, "utf8");
	const parseSource = readFileSync(parsePath, "utf8");

	// deriveSelector.ts is self-contained, so it transpiles whole. Its interface
	// declarations disappear on their own — they have no runtime form.
	const derive = transpile(deriveSource, "deriveSelector.ts").trim();

	// parse.ts imports cheerio, so only the one self-contained function is taken.
	const parsePrice = transpile(
		extractFunction(parseSource, "parse.ts", "parsePriceString"),
		"parsePriceString.ts",
	).trim();

	return `${[HEADER, derive, "", parsePrice].join("\n")}\n`;
}

const invokedDirectly =
	process.argv[1] !== undefined &&
	import.meta.url === `file://${process.argv[1].split(path.sep).join("/")}`;

if (invokedDirectly || process.env.FORCE_BUILD_EXTENSION === "1") {
	const generated = generate();

	let existing: string | null;
	try {
		existing = readFileSync(TARGET, "utf8");
	} catch {
		existing = null;
	}

	if (existing === generated) {
		console.log("extension/shared.generated.js is up to date");
	} else {
		writeFileSync(TARGET, generated, "utf8");
		console.log("wrote extension/shared.generated.js");
	}
}
