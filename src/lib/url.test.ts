import { describe, expect, it } from "vitest";
import { normaliseUrl } from "./url";

describe("normaliseUrl", () => {
	it("keeps a plain product URL intact", () => {
		expect(normaliseUrl("https://verkkokauppa.com/fi/product/123")).toEqual({
			url: "https://verkkokauppa.com/fi/product/123",
			hostname: "verkkokauppa.com",
		});
	});

	it("strips a leading www.", () => {
		const result = normaliseUrl("https://www.gigantti.fi/product/1");
		expect(result?.hostname).toBe("gigantti.fi");
		expect(result?.url).toBe("https://gigantti.fi/product/1");
	});

	it("lowercases the hostname but not the path", () => {
		const result = normaliseUrl("https://Example.FI/Product/ABC");
		expect(result?.hostname).toBe("example.fi");
		expect(result?.url).toBe("https://example.fi/Product/ABC");
	});

	it("removes tracking parameters", () => {
		const result = normaliseUrl(
			"https://a.fi/p?id=5&utm_source=news&gclid=xyz&fbclid=abc",
		);
		expect(result?.url).toBe("https://a.fi/p?id=5");
	});

	it("removes the trailing ? when every parameter was tracking", () => {
		const result = normaliseUrl("https://a.fi/p?utm_source=news");
		expect(result?.url).toBe("https://a.fi/p");
	});

	it("drops the fragment", () => {
		const result = normaliseUrl("https://a.fi/p#reviews");
		expect(result?.url).toBe("https://a.fi/p");
	});

	it("sorts query parameters so order does not create duplicates", () => {
		const a = normaliseUrl("https://a.fi/p?b=2&a=1");
		const b = normaliseUrl("https://a.fi/p?a=1&b=2");
		expect(a?.url).toBe(b?.url);
	});

	it("treats a newsletter link and a direct link as the same item", () => {
		const direct = normaliseUrl("https://www.gigantti.fi/product/1");
		const campaign = normaliseUrl(
			"https://gigantti.fi/product/1?utm_campaign=summer#top",
		);
		expect(direct?.url).toBe(campaign?.url);
	});

	it("rejects non-http(s) protocols", () => {
		expect(normaliseUrl("javascript:alert(1)")).toBeNull();
		expect(normaliseUrl("data:text/html,hi")).toBeNull();
		expect(normaliseUrl("chrome://extensions")).toBeNull();
		expect(normaliseUrl("file:///C:/secret.txt")).toBeNull();
		expect(normaliseUrl("about:blank")).toBeNull();
	});

	it("rejects malformed input", () => {
		expect(normaliseUrl("")).toBeNull();
		expect(normaliseUrl("not a url")).toBeNull();
		expect(normaliseUrl("   ")).toBeNull();
	});

	it("trims surrounding whitespace", () => {
		expect(normaliseUrl("  https://a.fi/p  ")?.url).toBe("https://a.fi/p");
	});

	it("preserves a non-default port", () => {
		expect(normaliseUrl("http://localhost:3000/p")?.url).toBe(
			"http://localhost:3000/p",
		);
	});
});
