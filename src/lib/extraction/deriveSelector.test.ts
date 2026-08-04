import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import {
	deriveSelector,
	type SelectorElement,
	type SelectorRoot,
	validates,
} from "./deriveSelector";

/**
 * The shape of a cheerio/domhandler element node, declared locally rather than
 * imported: cheerio's own node union covers text and comment nodes too, and
 * narrowing it at every access would obscure what this adapter is doing.
 */
interface CheerioNode {
	type: string;
	tagName?: string;
	attribs?: Record<string, string>;
	parent?: CheerioNode | null;
	children?: Array<CheerioNode>;
}

/**
 * Adapt cheerio to the structural DOM interface deriveSelector expects.
 *
 * cheerio is already a dependency (the extractor uses it), so this avoids
 * pulling in jsdom purely for tests. The adapter is deliberately thin: it
 * exposes exactly the members the module declares and nothing else, so a test
 * passing here cannot be relying on some richer DOM behaviour that the
 * extension's real elements would not provide.
 */
function domFrom(html: string): {
	root: SelectorRoot;
	find: (selector: string) => SelectorElement;
} {
	const $ = cheerio.load(html);

	// One wrapper per underlying node, so identity comparisons (matches[0] ===
	// target) behave the way they do with real DOM elements.
	const cache = new Map<CheerioNode, SelectorElement>();

	function wrap(node: CheerioNode): SelectorElement {
		const existing = cache.get(node);
		if (existing) {
			return existing;
		}

		const element: SelectorElement = {
			get tagName() {
				return String(node.tagName ?? "");
			},
			get id() {
				return node.attribs?.id ?? null;
			},
			get parentElement() {
				const parent = node.parent;
				return parent && parent.type === "tag" ? wrap(parent) : null;
			},
			getAttribute(name: string) {
				return node.attribs?.[name] ?? null;
			},
			get children() {
				return (node.children ?? [])
					.filter((child) => child.type === "tag")
					.map((child) => wrap(child));
			},
			get classList() {
				const raw = node.attribs?.class;
				return raw ? raw.split(/\s+/).filter(Boolean) : [];
			},
		};

		cache.set(node, element);
		return element;
	}

	return {
		root: {
			querySelectorAll(selector: string) {
				return $(selector)
					.toArray()
					.map((node) => wrap(node as unknown as CheerioNode));
			},
		},
		find(selector: string) {
			const node = $(selector).first().get(0);
			if (!node) {
				throw new Error(`fixture has no element matching ${selector}`);
			}
			return wrap(node as unknown as CheerioNode);
		},
	};
}

describe("validates", () => {
	it("accepts a selector matching exactly the target", () => {
		const { root, find } = domFrom(`<div id="a">x</div><div id="b">y</div>`);

		expect(validates(root, "#a", find("#a"))).toBe(true);
	});

	it("rejects a selector matching several elements", () => {
		const { root, find } = domFrom(`<p class="p">1</p><p class="p">2</p>`);

		// Ambiguity is a failure: the server would silently read whichever came
		// first, which on a real page is often the strike-through old price.
		expect(validates(root, ".p", find("p"))).toBe(false);
	});

	it("rejects a selector matching a different element", () => {
		const { root, find } = domFrom(`<div id="a">x</div><div id="b">y</div>`);

		expect(validates(root, "#b", find("#a"))).toBe(false);
	});

	it("treats an invalid selector as a failed candidate, not an error", () => {
		const { root, find } = domFrom(`<div id="a">x</div>`);

		expect(() => validates(root, "…:::bad(((", find("#a"))).not.toThrow();
		expect(validates(root, "…:::bad(((", find("#a"))).toBe(false);
	});
});

describe("deriveSelector — preference order", () => {
	it("prefers a test hook over a class", () => {
		const { root, find } = domFrom(
			`<div class="price-tag" data-test-id="product-price">14,99 €</div>`,
		);

		expect(deriveSelector(root, find("[data-test-id]"))).toBe(
			'[data-test-id="product-price"]',
		);
	});

	it("uses itemprop when present", () => {
		const { root, find } = domFrom(
			`<span itemprop="price" content="14.99">14,99 €</span>`,
		);

		expect(deriveSelector(root, find("[itemprop]"))).toBe('[itemprop="price"]');
	});

	it("falls back to a stable id", () => {
		const { root, find } = domFrom(`<div id="product-price">14,99 €</div>`);

		expect(deriveSelector(root, find("#product-price"))).toBe("#product-price");
	});

	it("falls back to a stable class", () => {
		const { root, find } = domFrom(
			`<div class="current-price">14,99 €</div><div class="other">x</div>`,
		);

		expect(deriveSelector(root, find(".current-price"))).toBe(".current-price");
	});
});

describe("deriveSelector — rejects unstable anchors", () => {
	// These fixtures offer no stable anchor at all, so the honest outcome is
	// either null or a structural path — never a selector built on the hashed
	// class, which changes on the store's next deploy.
	it("refuses CSS-module hashed classes", () => {
		const { root, find } = domFrom(
			`<div class="css-1x9f2a">14,99 €</div><div class="css-9z8y7x">x</div>`,
		);

		const selector = deriveSelector(root, find(".css-1x9f2a"));

		expect(selector ?? "").not.toContain("css-1x9f2a");
	});

	it("refuses styled-components hashed classes", () => {
		const { root, find } = domFrom(
			`<div class="sc-bdVaJa">14,99 €</div><div class="sc-other">x</div>`,
		);

		expect(deriveSelector(root, find(".sc-bdVaJa")) ?? "").not.toContain(
			"sc-bdVaJa",
		);
	});

	it("refuses a class containing a long hex run", () => {
		const { root, find } = domFrom(
			`<div class="price-a1b2c3d4">14,99 €</div><div class="x">y</div>`,
		);

		expect(deriveSelector(root, find(".price-a1b2c3d4")) ?? "").not.toContain(
			"a1b2c3d4",
		);
	});

	it("still finds a structural path when a hashed class has a stable ancestor", () => {
		// The realistic version of the cases above: hashed class on the price,
		// but a test hook on the card around it.
		const { root, find } = domFrom(`
			<div data-test-id="product-card">
				<span class="css-1x9f2a">14,99 €</span>
			</div>
		`);

		const target = find(".css-1x9f2a");
		const selector = deriveSelector(root, target);

		expect(selector).not.toBeNull();
		expect(selector).not.toContain("css-1x9f2a");
		expect(selector).toContain("product-card");
		expect(validates(root, selector as string, target)).toBe(true);
	});

	it("refuses a generated id but still uses a stable class", () => {
		const { root, find } = domFrom(
			`<div id="item-284719364" class="current-price">14,99 €</div>`,
		);

		const selector = deriveSelector(root, find(".current-price"));

		expect(selector).toBe(".current-price");
		expect(selector).not.toContain("284719364");
	});

	it("refuses a React-generated id", () => {
		const { root, find } = domFrom(
			`<div id=":r1a:" class="price-now">14,99 €</div>`,
		);

		expect(deriveSelector(root, find(".price-now"))).toBe(".price-now");
	});

	it("prefers a stable class over a hashed one on the same element", () => {
		const { root, find } = domFrom(
			`<div class="css-1x9f2a product-price">14,99 €</div><div class="css-zzz">x</div>`,
		);

		expect(deriveSelector(root, find(".product-price"))).toBe(".product-price");
	});
});

describe("deriveSelector — disambiguation", () => {
	it("does not return a class shared by several elements", () => {
		const { root, find } = domFrom(`
			<div class="price">10,00 €</div>
			<div class="price">20,00 €</div>
		`);

		const selector = deriveSelector(root, find(".price"));

		// ".price" alone matches two elements, so it must not be the answer.
		expect(selector).not.toBe(".price");
		if (selector !== null) {
			expect(validates(root, selector, find(".price"))).toBe(true);
		}
	});

	it("anchors a structural path on a stable ancestor", () => {
		const { root, find } = domFrom(`
			<div data-test-id="product-card">
				<span>label</span>
				<span>14,99 €</span>
			</div>
			<div data-test-id="other-card">
				<span>label</span>
				<span>99,00 €</span>
			</div>
		`);

		const target = find('[data-test-id="product-card"] span:nth-of-type(2)');
		const selector = deriveSelector(root, target);

		expect(selector).not.toBeNull();
		expect(selector).toContain("product-card");
		expect(validates(root, selector as string, target)).toBe(true);
	});

	it("uses nth-of-type rather than nth-child", () => {
		const { root, find } = domFrom(`
			<div id="card">
				<div>banner</div>
				<span>14,99 €</span>
			</div>
		`);

		const target = find("#card span");
		const selector = deriveSelector(root, target);

		expect(selector).not.toBeNull();
		expect(selector).not.toContain("nth-child");
		expect(validates(root, selector as string, target)).toBe(true);
	});

	it("resolves the same element after an unrelated sibling is inserted", () => {
		// The durability claim, tested rather than asserted: a promo <div>
		// appearing above the price must not invalidate the selector.
		const before = domFrom(`
			<div id="card">
				<span>label</span>
				<span>14,99 €</span>
			</div>
		`);

		const target = before.find("#card span:nth-of-type(2)");
		const selector = deriveSelector(before.root, target);

		expect(selector).not.toBeNull();

		const after = domFrom(`
			<div id="card">
				<div class="promo">Ale!</div>
				<span>label</span>
				<span>14,99 €</span>
			</div>
		`);

		const stillMatches = after.root.querySelectorAll(selector as string);

		expect(stillMatches.length).toBe(1);
	});
});

describe("deriveSelector — refuses rather than guessing", () => {
	it("returns null when no candidate uniquely identifies the element", () => {
		// Two structurally identical, attribute-free subtrees: nothing can tell
		// the two inner spans apart, so there is no honest answer.
		const { root, find } = domFrom(`
			<section><div><span>10,00 €</span></div></section>
			<section><div><span>10,00 €</span></div></section>
		`);

		expect(deriveSelector(root, find("section span"))).toBeNull();
	});

	it("never returns a selector that does not validate", () => {
		const fixtures = [
			`<div class="css-abc123">1</div>`,
			`<div id="x-9999999">2</div>`,
			`<p><em>3</em></p>`,
			`<div data-test-id="p">4</div>`,
			`<ul><li>a</li><li>b</li><li>c</li></ul>`,
		];

		for (const html of fixtures) {
			const { root } = domFrom(html);
			const all = root.querySelectorAll("*");

			for (let i = 0; i < all.length; i += 1) {
				const element = all[i] as SelectorElement;
				const selector = deriveSelector(root, element);

				if (selector !== null) {
					expect(validates(root, selector, element)).toBe(true);
				}
			}
		}
	});
});
