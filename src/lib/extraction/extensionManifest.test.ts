import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static checks on the extension.
 *
 * Chrome loads extension/ unpacked with no build step, so nothing else verifies
 * these files until they are installed by hand — and a bad manifest or a typo
 * in a filename fails silently at injection time rather than loudly here.
 *
 * These do not replace loading the extension and picking a real price; they
 * catch the mistakes that would waste that manual pass.
 */

const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../..",
);
const extensionDir = path.join(root, "extension");

function readExtensionFile(name: string): string {
	return readFileSync(path.join(extensionDir, name), "utf8");
}

const manifest = JSON.parse(readExtensionFile("manifest.json")) as {
	manifest_version: number;
	permissions: Array<string>;
	host_permissions: Array<string>;
	web_accessible_resources?: Array<{
		resources: Array<string>;
		matches: Array<string>;
	}>;
	background: { service_worker: string; type: string };
};

describe("extension manifest", () => {
	it("requests the scripting permission the picker needs", () => {
		// Without this, executeScript throws at click time with a message the
		// user cannot act on.
		expect(manifest.permissions).toContain("scripting");
	});

	it("keeps the permissions the existing features rely on", () => {
		expect(manifest.permissions).toContain("tabs");
		expect(manifest.permissions).toContain("storage");
	});

	it("exposes every file the picker dynamically imports", () => {
		const exposed = manifest.web_accessible_resources?.[0]?.resources ?? [];

		// picker-entry.js is injected; it imports picker.js, which imports
		// shared.generated.js. A missing entry here fails only in the page, as an
		// opaque module-load error.
		expect(exposed).toContain("picker-entry.js");
		expect(exposed).toContain("picker.js");
		expect(exposed).toContain("shared.generated.js");
	});

	it("adds no host permission beyond what already existed", () => {
		// The picker deliberately does not widen access: it reuses the https://*/*
		// grant the bulk import already required.
		expect(manifest.host_permissions).toEqual([
			"http://localhost/*",
			"https://*/*",
		]);
	});
});

describe("extension sources parse", () => {
	// A syntax error in an injected file surfaces in Chrome as a refusal to
	// inject, with no useful message. Catch it here instead.
	const modules = [
		"picker.js",
		"picker-entry.js",
		"popup.js",
		"service-worker.js",
		"config.js",
		"shared.generated.js",
	];

	for (const name of modules) {
		it(`${name} is syntactically valid`, () => {
			const source = readExtensionFile(name);

			// Strip module syntax that `new Function` cannot host, keeping the rest
			// of the body intact.
			const body = source
				.replace(/^import[\s\S]*?;$/gm, "")
				.replace(/^export /gm, "");

			expect(() => new Function(body)).not.toThrow();
		});
	}
});

describe("extension message contracts", () => {
	const worker = readExtensionFile("service-worker.js");
	const popup = readExtensionFile("popup.js");
	const entry = readExtensionFile("picker-entry.js");

	it("worker handles every message type that is sent", () => {
		// A typo here means a message is silently ignored and the flow just stops.
		expect(popup).toMatch(/type:\s*"ingest"/);
		expect(popup).toMatch(/type:\s*"pick"/);
		expect(entry).toMatch(/type:\s*"picked"/);

		expect(worker).toMatch(/message\?\.type === "ingest"/);
		expect(worker).toMatch(/message\?\.type === "pick"/);
		expect(worker).toMatch(/message\?\.type === "picked"/);
	});

	it("sends the picked price in the shape /api/ingest accepts", () => {
		// MAJOR units and the exact field names the zod union expects.
		expect(worker).toMatch(/priceSelector:/);
		expect(worker).toMatch(/observedPrice:/);
		// Set conditionally, so it appears as a property assignment rather than
		// an object literal key.
		expect(worker).toMatch(/observedCurrency\s*[:=]/);
	});

	it("injects the entry module rather than picker.js directly", () => {
		// picker.js uses a static import, which an injected non-module file
		// cannot; injecting it directly fails at runtime.
		expect(worker).toMatch(/files:\s*\["picker-entry\.js"\]/);
	});
});

describe("picker safety", () => {
	const picker = readExtensionFile("picker.js");

	it("routes every exit through a single teardown", () => {
		// A picker that leaves its listeners attached would keep swallowing
		// clicks on the user's page after it finished.
		expect(picker).toMatch(/function teardown\(/);
		expect(picker).toMatch(/removeEventListener\("mousemove", onMove, true\)/);
		expect(picker).toMatch(/removeEventListener\("click", onClick, true\)/);
		expect(picker).toMatch(/removeEventListener\("keydown", onKey, true\)/);
	});

	it("guards against double injection", () => {
		expect(picker).toMatch(/__hintavahtiPickerActive/);
	});

	it("refuses to report a price it could not parse", () => {
		expect(picker).toMatch(/price === null/);
	});

	it("refuses to report a selector it could not derive", () => {
		expect(picker).toMatch(/selector === null/);
	});
});
