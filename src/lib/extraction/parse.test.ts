import { describe, expect, it } from "vitest";
import { parsePriceString, parseProductHtml } from "./parse";

const PAGE_URL = "https://www.verkkokauppa.com/fi/product/12345/example";

/** Wrap fragment HTML in a minimal document so cheerio sees a real page. */
function page(body: string, head = ""): string {
	return `<!doctype html><html><head><title>Example Store</title>${head}</head><body>${body}</body></html>`;
}

describe("parsePriceString", () => {
	it("passes through a plain number unchanged", () => {
		expect(parsePriceString(1299)).toBe(1299);
		expect(parsePriceString(19.99)).toBe(19.99);
	});

	it("parses a plain decimal string", () => {
		expect(parsePriceString("1299.00")).toBe(1299);
		expect(parsePriceString("19.99")).toBe(19.99);
	});

	it("parses European comma decimals", () => {
		expect(parsePriceString("19,99")).toBe(19.99);
		expect(parsePriceString("1299,00")).toBe(1299);
	});

	it("parses both grouping conventions with a decimal part", () => {
		expect(parsePriceString("1.299,00")).toBe(1299);
		expect(parsePriceString("1,299.00")).toBe(1299);
		expect(parsePriceString("1.234.567,89")).toBe(1234567.89);
	});

	it("strips currency symbols and Finnish spacing", () => {
		// U+00A0 thousands separator, U+202F before the symbol.
		expect(parsePriceString("1 299,00 €")).toBe(1299);
		expect(parsePriceString("€19.99")).toBe(19.99);
		expect(parsePriceString("  19,99 EUR ")).toBe(19.99);
	});

	it("reads a lone 3-digit tail as a thousands group", () => {
		expect(parsePriceString("1.299")).toBe(1299);
		expect(parsePriceString("1,299")).toBe(1299);
	});

	it("reads a lone 1- or 2-digit tail as decimals", () => {
		expect(parsePriceString("12,5")).toBe(12.5);
		expect(parsePriceString("12.50")).toBe(12.5);
	});

	it("refuses input it cannot read unambiguously", () => {
		expect(parsePriceString("1.2345")).toBeNull();
		expect(parsePriceString("12,3456")).toBeNull();
		// Grouped form with a malformed group.
		expect(parsePriceString("1.29.00")).toBeNull();
	});

	it("rejects empty, non-numeric, zero and negative values", () => {
		expect(parsePriceString(null)).toBeNull();
		expect(parsePriceString("")).toBeNull();
		expect(parsePriceString("Ota yhteyttä")).toBeNull();
		expect(parsePriceString("0")).toBeNull();
		expect(parsePriceString("-19,99")).toBeNull();
		expect(parsePriceString(Number.NaN)).toBeNull();
	});
});

describe("parseProductHtml — JSON-LD", () => {
	it("reads price, currency, title, image and availability", () => {
		const html = page(
			"",
			`<script type="application/ld+json">${JSON.stringify({
				"@context": "https://schema.org",
				"@type": "Product",
				name: "Example Headphones",
				image: "https://cdn.example.com/img.jpg",
				offers: {
					"@type": "Offer",
					price: "1299.00",
					priceCurrency: "EUR",
					availability: "https://schema.org/InStock",
				},
			})}</script>`,
		);

		const result = parseProductHtml(html, PAGE_URL);

		expect(result.ok).toBe(true);
		expect(result.method).toBe("json-ld");
		expect(result.price).toBe(1299);
		expect(result.currency).toBe("EUR");
		expect(result.title).toBe("Example Headphones");
		expect(result.image).toBe("https://cdn.example.com/img.jpg");
		expect(result.availability).toBe("in_stock");
	});

	it("finds a Product nested in @graph", () => {
		const html = page(
			"",
			`<script type="application/ld+json">${JSON.stringify({
				"@context": "https://schema.org",
				"@graph": [
					{ "@type": "WebSite", name: "Store" },
					{
						"@type": "Product",
						name: "Nested Product",
						offers: { "@type": "Offer", price: 49.9, priceCurrency: "EUR" },
					},
				],
			})}</script>`,
		);

		const result = parseProductHtml(html, PAGE_URL);

		expect(result.ok).toBe(true);
		expect(result.price).toBe(49.9);
		expect(result.title).toBe("Nested Product");
	});

	it("takes the lowest price across offer variants", () => {
		const html = page(
			"",
			`<script type="application/ld+json">${JSON.stringify({
				"@type": "Product",
				name: "Variant Product",
				offers: [
					{ "@type": "Offer", price: "89.00", priceCurrency: "EUR" },
					{ "@type": "Offer", price: "59.00", priceCurrency: "EUR" },
					{ "@type": "Offer", price: "129.00", priceCurrency: "EUR" },
				],
			})}</script>`,
		);

		expect(parseProductHtml(html, PAGE_URL).price).toBe(59);
	});

	it("reads lowPrice from an AggregateOffer", () => {
		const html = page(
			"",
			`<script type="application/ld+json">${JSON.stringify({
				"@type": "Product",
				name: "Aggregate Product",
				offers: {
					"@type": "AggregateOffer",
					lowPrice: "35.50",
					highPrice: "99.00",
					priceCurrency: "EUR",
				},
			})}</script>`,
		);

		expect(parseProductHtml(html, PAGE_URL).price).toBe(35.5);
	});

	it("skips a malformed block and uses a later valid one", () => {
		const html = page(
			"",
			`<script type="application/ld+json">{ not json </script>
			 <script type="application/ld+json">${JSON.stringify({
					"@type": "Product",
					name: "Recovered",
					offers: { "@type": "Offer", price: "10.00", priceCurrency: "EUR" },
				})}</script>`,
		);

		const result = parseProductHtml(html, PAGE_URL);

		expect(result.ok).toBe(true);
		expect(result.price).toBe(10);
	});

	it("maps OutOfStock availability", () => {
		const html = page(
			"",
			`<script type="application/ld+json">${JSON.stringify({
				"@type": "Product",
				name: "Sold Out",
				offers: {
					"@type": "Offer",
					price: "10.00",
					priceCurrency: "EUR",
					availability: "OutOfStock",
				},
			})}</script>`,
		);

		expect(parseProductHtml(html, PAGE_URL).availability).toBe("out_of_stock");
	});
});

describe("parseProductHtml — microdata", () => {
	it("falls back to microdata when JSON-LD has no price", () => {
		const html = page(`
			<div itemscope itemtype="https://schema.org/Product">
				<span itemprop="name">Microdata Product</span>
				<span itemprop="price" content="249.90">249,90 €</span>
				<meta itemprop="priceCurrency" content="EUR">
				<link itemprop="availability" href="https://schema.org/InStock">
			</div>
		`);

		const result = parseProductHtml(html, PAGE_URL);

		expect(result.ok).toBe(true);
		expect(result.method).toBe("microdata");
		expect(result.price).toBe(249.9);
		expect(result.currency).toBe("EUR");
		expect(result.title).toBe("Microdata Product");
		expect(result.availability).toBe("in_stock");
	});

	it("reads a price from element text when there is no content attribute", () => {
		const html = page(`
			<div itemscope itemtype="https://schema.org/Product">
				<span itemprop="name">Text Price</span>
				<span itemprop="price">1 299,00 €</span>
			</div>
		`);

		const result = parseProductHtml(html, PAGE_URL);

		expect(result.price).toBe(1299);
		expect(result.method).toBe("microdata");
	});
});

describe("parseProductHtml — meta tags", () => {
	it("falls back to OG meta when structured data is absent", () => {
		const html = page(
			"",
			`<meta property="og:title" content="Meta Product">
			 <meta property="og:image" content="/img/product.png">
			 <meta property="og:price:amount" content="59.95">
			 <meta property="og:price:currency" content="EUR">`,
		);

		const result = parseProductHtml(html, PAGE_URL);

		expect(result.ok).toBe(true);
		expect(result.method).toBe("meta");
		expect(result.price).toBe(59.95);
		expect(result.currency).toBe("EUR");
		expect(result.title).toBe("Meta Product");
		// Relative image resolved against the page URL.
		expect(result.image).toBe("https://www.verkkokauppa.com/img/product.png");
	});

	it("reads product:price:amount as well", () => {
		const html = page(
			"",
			`<meta property="product:price:amount" content="12,50">
			 <meta property="product:price:currency" content="EUR">`,
		);

		expect(parseProductHtml(html, PAGE_URL).price).toBe(12.5);
	});
});

describe("parseProductHtml — site selectors", () => {
	it("uses a per-host selector as the last resort", () => {
		const html = page(
			`<h1>Selector Product</h1>
			 <div data-test-id="product-price">1 299,00 €</div>`,
		);

		const result = parseProductHtml(html, PAGE_URL);

		expect(result.ok).toBe(true);
		expect(result.method).toBe("selector");
		expect(result.price).toBe(1299);
		// Currency recovered from the rendered symbol.
		expect(result.currency).toBe("EUR");
		expect(result.title).toBe("Selector Product");
	});

	it("does not apply another host's selectors", () => {
		const html = page(
			`<h1>Wrong Host</h1>
			 <div data-test-id="product-price">1 299,00 €</div>`,
		);

		const result = parseProductHtml(html, "https://example.com/product/1");

		expect(result.ok).toBe(false);
		expect(result.price).toBeNull();
	});

	it("matches a host regardless of the www prefix", () => {
		const html = page(`<div data-test-id="product-price">99,00 €</div>`);

		expect(
			parseProductHtml(html, "https://verkkokauppa.com/fi/product/1").price,
		).toBe(99);
	});
});

describe("parseProductHtml — user-picked selector", () => {
	it("beats JSON-LD when it matches", () => {
		// The point of the picker: the page advertises a base model in JSON-LD,
		// the user pointed at the variant they actually want.
		const html = page(
			`<div class="variant-price">249,00 €</div>`,
			`<script type="application/ld+json">${JSON.stringify({
				"@type": "Product",
				name: "Base Model",
				offers: { "@type": "Offer", price: "199.00", priceCurrency: "EUR" },
			})}</script>`,
		);

		const result = parseProductHtml(html, PAGE_URL, {
			priceSelector: ".variant-price",
		});

		expect(result.ok).toBe(true);
		expect(result.price).toBe(249);
		expect(result.method).toBe("selector");
		expect(result.userSelectorFailed).toBeUndefined();
	});

	it("reads a content attribute in preference to text", () => {
		const html = page(`<span class="p" content="149.50">jotain muuta</span>`);

		expect(
			parseProductHtml(html, PAGE_URL, { priceSelector: ".p" }).price,
		).toBe(149.5);
	});

	it("falls through to the cascade when the selector no longer matches", () => {
		// A store redesign must degrade to the generic cascade, not break the item.
		const html = page(
			"",
			`<script type="application/ld+json">${JSON.stringify({
				"@type": "Product",
				name: "Still Works",
				offers: { "@type": "Offer", price: "199.00", priceCurrency: "EUR" },
			})}</script>`,
		);

		const result = parseProductHtml(html, PAGE_URL, {
			priceSelector: ".gone-in-the-redesign",
		});

		expect(result.ok).toBe(true);
		expect(result.price).toBe(199);
		expect(result.method).toBe("json-ld");
		// Flagged so the UI can prompt a re-pick, even though the price is fine.
		expect(result.userSelectorFailed).toBe(true);
	});

	it("falls through when the selector matches a non-price string", () => {
		const html = page(
			`<div class="p">Ota yhteyttä</div>`,
			`<script type="application/ld+json">${JSON.stringify({
				"@type": "Product",
				name: "Fallback",
				offers: { "@type": "Offer", price: "99.00", priceCurrency: "EUR" },
			})}</script>`,
		);

		const result = parseProductHtml(html, PAGE_URL, { priceSelector: ".p" });

		expect(result.price).toBe(99);
		expect(result.userSelectorFailed).toBe(true);
	});

	it("reports failure when the selector misses and nothing else has a price", () => {
		const html = page(`<div class="other">no price anywhere</div>`);

		const result = parseProductHtml(html, PAGE_URL, {
			priceSelector: ".missing",
		});

		expect(result.ok).toBe(false);
		expect(result.userSelectorFailed).toBe(true);
		expect(result.error).toContain("no longer matches");
	});

	it("treats an invalid selector as a miss rather than throwing", () => {
		const html = page(`<div class="p">10,00 €</div>`);

		expect(() =>
			parseProductHtml(html, PAGE_URL, { priceSelector: ":::not-css(((" }),
		).not.toThrow();
	});

	it("does not set the flag when no selector was supplied", () => {
		const html = page(`<div class="other">nothing</div>`);

		expect(parseProductHtml(html, PAGE_URL).userSelectorFailed).toBeUndefined();
	});

	it("parses Finnish formatting from the picked element", () => {
		const html = page(`<div class="p">1 299,00 €</div>`);

		const result = parseProductHtml(html, PAGE_URL, { priceSelector: ".p" });

		expect(result.price).toBe(1299);
		expect(result.currency).toBe("EUR");
	});
});

describe("parseProductHtml — cascade precedence and failure", () => {
	it("prefers JSON-LD over every weaker source", () => {
		const html = page(
			`<div itemprop="price" content="200.00"></div>
			 <div data-test-id="product-price">300,00 €</div>`,
			`<script type="application/ld+json">${JSON.stringify({
				"@type": "Product",
				name: "Cascade",
				offers: { "@type": "Offer", price: "100.00", priceCurrency: "EUR" },
			})}</script>
			 <meta property="og:price:amount" content="400.00">`,
		);

		const result = parseProductHtml(html, PAGE_URL);

		expect(result.method).toBe("json-ld");
		expect(result.price).toBe(100);
	});

	it("returns ok:false with an error rather than guessing", () => {
		const html = page(`<div class="price">Kysy hintaa</div>`);

		const result = parseProductHtml(html, PAGE_URL);

		expect(result.ok).toBe(false);
		expect(result.price).toBeNull();
		expect(result.method).toBeNull();
		expect(result.error).toContain("no price found");
	});

	it("preserves colons in an absolute CDN image path", () => {
		// Verkkokauppa's thumbnailer emits path segments like "sh:0.5". Pin the
		// colon-heavy form so any future normalisation of absolute URLs has to
		// prove it does not mangle it.
		const cdn =
			"https://static.verkcdn.com/kuvastin/w:576/h:576/rt:fit/q:80/sh:0.5/plain/images/73/2_279.jpeg";
		const html = page(
			"",
			`<script type="application/ld+json">${JSON.stringify({
				"@type": "Product",
				name: "CDN Image",
				image: [cdn],
				offers: { "@type": "Offer", price: "11.99", priceCurrency: "EUR" },
			})}</script>`,
		);

		expect(parseProductHtml(html, PAGE_URL).image).toBe(cdn);
	});

	it("resolves a protocol-relative image against the page scheme", () => {
		const html = page(
			"",
			`<meta property="og:image" content="//cdn.example.com/x.jpg">
			 <meta property="og:price:amount" content="10.00">`,
		);

		expect(parseProductHtml(html, PAGE_URL).image).toBe(
			"https://cdn.example.com/x.jpg",
		);
	});

	it("rejects a non-http image scheme", () => {
		const html = page(
			"",
			`<meta property="og:image" content="javascript:alert(1)">
			 <meta property="og:price:amount" content="10.00">`,
		);

		expect(parseProductHtml(html, PAGE_URL).image).toBeNull();
	});

	it("still reports title and image on failure", () => {
		const html = page(
			"",
			`<meta property="og:title" content="No Price Product">
			 <meta property="og:image" content="https://cdn.example.com/x.jpg">`,
		);

		const result = parseProductHtml(html, PAGE_URL);

		expect(result.ok).toBe(false);
		expect(result.title).toBe("No Price Product");
		expect(result.image).toBe("https://cdn.example.com/x.jpg");
	});

	it("falls back to the document title when no stage names the product", () => {
		const html = page(`<div data-test-id="product-price">10,00 €</div>`);

		expect(parseProductHtml(html, PAGE_URL).title).toBe("Example Store");
	});

	it("takes availability from another stage when the price stage is silent", () => {
		// Price comes from the selector stage, which never reports availability;
		// the JSON-LD block has no price but does state stock.
		const html = page(
			`<div data-test-id="product-price">10,00 €</div>`,
			`<script type="application/ld+json">${JSON.stringify({
				"@type": "Product",
				name: "Stock Elsewhere",
				offers: {
					"@type": "Offer",
					availability: "https://schema.org/OutOfStock",
				},
			})}</script>`,
		);

		const result = parseProductHtml(html, PAGE_URL);

		expect(result.method).toBe("selector");
		expect(result.availability).toBe("out_of_stock");
	});

	it("returns a failure for HTML with no product markup at all", () => {
		const result = parseProductHtml(page("<p>Hello</p>"), PAGE_URL);

		expect(result.ok).toBe(false);
		expect(result.url).toBe(PAGE_URL);
	});
});
