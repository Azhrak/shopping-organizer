import { beforeEach, describe, expect, it } from "vitest";
import { db } from "~/lib/db";
import type { ExtractPriceOptions, PriceResult } from "~/lib/extraction/types";
import { resetTestDatabase } from "~/test/db";
import {
	addItem,
	checkItem,
	findDueItems,
	getItemStats,
	InvalidUrlError,
	ItemNotFoundError,
	type ServiceDeps,
} from "./items.service";

/**
 * A controllable extractor for tests. The real extractPrice makes outbound
 * HTTP requests to live stores, which cannot be part of a deterministic test
 * suite — this drives the same PriceResult contract from a queue instead.
 */
function fakeExtractor() {
	const queue: Array<PriceResult> = [];
	const calls: Array<string> = [];
	/** Options each call received, so tests can assert what was threaded through. */
	const callOptions: Array<ExtractPriceOptions | undefined> = [];

	return {
		calls,
		callOptions,
		queueSuccess(price: number, extra: Partial<PriceResult> = {}) {
			queue.push({
				ok: true,
				url: "",
				price,
				currency: "EUR",
				title: "Test Product",
				image: null,
				availability: "in_stock",
				method: "json-ld",
				...extra,
			});
		},
		queueFailure(error = "no price found") {
			queue.push({
				ok: false,
				url: "",
				price: null,
				currency: null,
				title: null,
				image: null,
				availability: "unknown",
				method: null,
				error,
			});
		},
		fn: async (
			url: string,
			options?: ExtractPriceOptions,
		): Promise<PriceResult> => {
			calls.push(url);
			callOptions.push(options);
			const next = queue.shift();
			if (!next) {
				throw new Error("fakeExtractor: no queued result");
			}
			return { ...next, url };
		},
	};
}

function makeDeps(
	extractor: ReturnType<typeof fakeExtractor>,
	now?: Date,
): ServiceDeps {
	return {
		db,
		extractPrice: extractor.fn,
		now: now ? () => now : undefined,
	};
}

const T0 = new Date("2026-08-03T12:00:00.000Z");

function plusHours(base: Date, hours: number): Date {
	return new Date(base.getTime() + hours * 60 * 60 * 1000);
}

describe("addItem", () => {
	beforeEach(async () => {
		await resetTestDatabase();
	});

	it("saves an item and its first price check", async () => {
		const ex = fakeExtractor();
		ex.queueSuccess(1299.0);

		const result = await addItem(
			makeDeps(ex, T0),
			"https://www.verkkokauppa.com/fi/product/1?utm_source=x",
		);

		expect(result.created).toBe(true);
		expect(result.extractFailing).toBe(false);
		expect(result.price).toBe(129900);

		const item = await db
			.selectFrom("items")
			.selectAll()
			.where("id", "=", result.itemId)
			.executeTakeFirstOrThrow();

		// URL was normalised before storage.
		expect(item.url).toBe("https://verkkokauppa.com/fi/product/1");
		expect(item.store_hostname).toBe("verkkokauppa.com");
		expect(item.extract_failing).toBe(false);
		expect(item.consecutive_failures).toBe(0);
		expect(item.extract_method).toBe("json-ld");
		expect(item.currency).toBe("EUR");

		const checks = await db
			.selectFrom("price_checks")
			.selectAll()
			.where("item_id", "=", result.itemId)
			.execute();

		expect(checks).toHaveLength(1);
		expect(checks[0].price).toBe(129900);
		expect(checks[0].availability).toBe("in_stock");
	});

	it("saves the item anyway when extraction fails", async () => {
		const ex = fakeExtractor();
		ex.queueFailure("404");

		const result = await addItem(makeDeps(ex, T0), "https://a.fi/gone");

		expect(result.created).toBe(true);
		expect(result.extractFailing).toBe(true);
		expect(result.price).toBeNull();
		expect(result.error).toBe("404");

		const item = await db
			.selectFrom("items")
			.selectAll()
			.where("id", "=", result.itemId)
			.executeTakeFirstOrThrow();

		expect(item.extract_failing).toBe(true);
		expect(item.consecutive_failures).toBe(1);

		// A failed extraction writes no price row.
		const checks = await db.selectFrom("price_checks").selectAll().execute();
		expect(checks).toHaveLength(0);
	});

	it("backs off the next check for an item that failed on add", async () => {
		const ex = fakeExtractor();
		ex.queueFailure();

		const result = await addItem(makeDeps(ex, T0), "https://a.fi/gone");

		const item = await db
			.selectFrom("items")
			.select("next_check_at")
			.where("id", "=", result.itemId)
			.executeTakeFirstOrThrow();

		// One failure doubles the 12h base interval to 24h.
		expect(item.next_check_at).toEqual(plusHours(T0, 24));
	});

	it("returns the existing item when the URL is already tracked", async () => {
		const ex = fakeExtractor();
		ex.queueSuccess(1299.0);

		const first = await addItem(makeDeps(ex, T0), "https://a.fi/p");
		const second = await addItem(makeDeps(ex, T0), "https://a.fi/p");

		expect(second.created).toBe(false);
		expect(second.itemId).toBe(first.itemId);
		// The extractor was not called a second time.
		expect(ex.calls).toHaveLength(1);

		const count = await db.selectFrom("items").selectAll().execute();
		expect(count).toHaveLength(1);
	});

	it("treats URLs differing only by tracking params as the same item", async () => {
		const ex = fakeExtractor();
		ex.queueSuccess(1299.0);

		const first = await addItem(makeDeps(ex, T0), "https://www.a.fi/p");
		const second = await addItem(
			makeDeps(ex, T0),
			"https://a.fi/p?utm_campaign=sale#reviews",
		);

		expect(second.created).toBe(false);
		expect(second.itemId).toBe(first.itemId);
	});

	it("rejects a non-http URL without touching the database", async () => {
		const ex = fakeExtractor();

		await expect(
			addItem(makeDeps(ex, T0), "chrome://extensions"),
		).rejects.toBeInstanceOf(InvalidUrlError);

		expect(ex.calls).toHaveLength(0);
		expect(await db.selectFrom("items").selectAll().execute()).toHaveLength(0);
	});

	it("treats an unconvertible price as a failure rather than storing it", async () => {
		const ex = fakeExtractor();
		ex.queueSuccess(Number.POSITIVE_INFINITY);

		const result = await addItem(makeDeps(ex, T0), "https://a.fi/p");

		expect(result.extractFailing).toBe(true);
		expect(
			await db.selectFrom("price_checks").selectAll().execute(),
		).toHaveLength(0);
	});
});

describe("checkItem", () => {
	beforeEach(async () => {
		await resetTestDatabase();
	});

	async function seedItem(
		ex: ReturnType<typeof fakeExtractor>,
		price: number,
		at: Date = T0,
	) {
		ex.queueSuccess(price);
		return addItem(makeDeps(ex, at), "https://a.fi/p");
	}

	it("appends a price check without altering earlier rows", async () => {
		const ex = fakeExtractor();
		const added = await seedItem(ex, 100.0);

		ex.queueSuccess(90.0);
		await checkItem(makeDeps(ex, plusHours(T0, 12)), added.itemId);

		const checks = await db
			.selectFrom("price_checks")
			.select(["price", "checked_at"])
			.where("item_id", "=", added.itemId)
			.orderBy("checked_at", "asc")
			.execute();

		expect(checks.map((c) => c.price)).toEqual([10000, 9000]);
	});

	it("reports a drop against the target price", async () => {
		const ex = fakeExtractor();
		const added = await seedItem(ex, 100.0);

		await db
			.updateTable("items")
			.set({ target_price: 9500 })
			.where("id", "=", added.itemId)
			.execute();

		ex.queueSuccess(90.0);
		const result = await checkItem(
			makeDeps(ex, plusHours(T0, 12)),
			added.itemId,
		);

		expect(result.isDrop).toBe(true);
		expect(result.dropReason).toBe("target");
		expect(result.price).toBe(9000);
		expect(result.previousPrice).toBe(10000);

		const item = await db
			.selectFrom("items")
			.select(["last_alert_price", "last_alerted_at"])
			.where("id", "=", added.itemId)
			.executeTakeFirstOrThrow();

		expect(item.last_alert_price).toBe(9000);
		expect(item.last_alerted_at).toEqual(plusHours(T0, 12));
	});

	it("does not alert twice at the same price level", async () => {
		const ex = fakeExtractor();
		const added = await seedItem(ex, 100.0);

		await db
			.updateTable("items")
			.set({ target_price: 9500 })
			.where("id", "=", added.itemId)
			.execute();

		ex.queueSuccess(90.0);
		const first = await checkItem(
			makeDeps(ex, plusHours(T0, 12)),
			added.itemId,
		);
		expect(first.isDrop).toBe(true);

		// Back up, then down to the same level again.
		ex.queueSuccess(100.0);
		await checkItem(makeDeps(ex, plusHours(T0, 24)), added.itemId);

		ex.queueSuccess(90.0);
		const third = await checkItem(
			makeDeps(ex, plusHours(T0, 36)),
			added.itemId,
		);

		expect(third.isDrop).toBe(false);

		// A genuine new low still alerts.
		ex.queueSuccess(85.0);
		const fourth = await checkItem(
			makeDeps(ex, plusHours(T0, 48)),
			added.itemId,
		);
		expect(fourth.isDrop).toBe(true);
	});

	it("records a failure without writing a price row", async () => {
		const ex = fakeExtractor();
		const added = await seedItem(ex, 100.0);

		ex.queueFailure("timeout");
		const result = await checkItem(
			makeDeps(ex, plusHours(T0, 12)),
			added.itemId,
		);

		expect(result.ok).toBe(false);
		expect(result.consecutiveFailures).toBe(1);
		expect(result.error).toBe("timeout");

		const checks = await db
			.selectFrom("price_checks")
			.selectAll()
			.where("item_id", "=", added.itemId)
			.execute();

		// Still only the original check from addItem.
		expect(checks).toHaveLength(1);

		const item = await db
			.selectFrom("items")
			.select(["extract_failing", "consecutive_failures", "next_check_at"])
			.where("id", "=", added.itemId)
			.executeTakeFirstOrThrow();

		expect(item.extract_failing).toBe(true);
		expect(item.consecutive_failures).toBe(1);
		expect(item.next_check_at).toEqual(plusHours(plusHours(T0, 12), 24));
	});

	it("backs off exponentially over repeated failures", async () => {
		const ex = fakeExtractor();
		const added = await seedItem(ex, 100.0);

		const expectedHours = [24, 48, 96];

		for (let i = 0; i < expectedHours.length; i++) {
			ex.queueFailure();
			const at = plusHours(T0, 12 * (i + 1));
			const result = await checkItem(makeDeps(ex, at), added.itemId);

			expect(result.consecutiveFailures).toBe(i + 1);
			expect(result.nextCheckAt).toEqual(plusHours(at, expectedHours[i]));
		}
	});

	it("clears the failure state once extraction succeeds again", async () => {
		const ex = fakeExtractor();
		const added = await seedItem(ex, 100.0);

		ex.queueFailure();
		await checkItem(makeDeps(ex, plusHours(T0, 12)), added.itemId);

		ex.queueSuccess(95.0);
		const recovered = await checkItem(
			makeDeps(ex, plusHours(T0, 36)),
			added.itemId,
		);

		expect(recovered.ok).toBe(true);
		expect(recovered.consecutiveFailures).toBe(0);

		const item = await db
			.selectFrom("items")
			.select(["extract_failing", "consecutive_failures", "next_check_at"])
			.where("id", "=", added.itemId)
			.executeTakeFirstOrThrow();

		expect(item.extract_failing).toBe(false);
		expect(item.consecutive_failures).toBe(0);
		// Back to the base 12h interval.
		expect(item.next_check_at).toEqual(plusHours(plusHours(T0, 36), 12));
	});

	it("ignores prices outside the 90-day window when judging a trailing low", async () => {
		const ex = fakeExtractor();
		const added = await seedItem(ex, 50.0, T0);

		// 120 days later the old 50.00 is out of window; 80.00 becomes the
		// in-window baseline, so 70.00 is a new trailing low.
		const later = plusHours(T0, 24 * 120);
		ex.queueSuccess(80.0);
		await checkItem(makeDeps(ex, later), added.itemId);

		ex.queueSuccess(70.0);
		const result = await checkItem(
			makeDeps(ex, plusHours(later, 12)),
			added.itemId,
		);

		expect(result.isDrop).toBe(true);
		expect(result.dropReason).toBe("trailing-low");
	});

	it("throws for an unknown item", async () => {
		const ex = fakeExtractor();
		await expect(
			checkItem(makeDeps(ex, T0), "00000000-0000-0000-0000-000000000000"),
		).rejects.toBeInstanceOf(ItemNotFoundError);
	});
});

describe("getItemStats", () => {
	beforeEach(async () => {
		await resetTestDatabase();
	});

	it("returns empty stats for an item with no price history", async () => {
		const ex = fakeExtractor();
		ex.queueFailure();
		const added = await addItem(makeDeps(ex, T0), "https://a.fi/p");

		const stats = await getItemStats(makeDeps(ex, T0), added.itemId);

		expect(stats.current).toBeNull();
		expect(stats.percentVsTypical).toBeNull();
		expect(stats.totalSampleCount).toBe(0);
	});

	it("computes percent-vs-typical from stored history", async () => {
		const ex = fakeExtractor();
		ex.queueSuccess(100.0);
		const added = await addItem(makeDeps(ex, T0), "https://a.fi/p");

		ex.queueSuccess(100.0);
		await checkItem(makeDeps(ex, plusHours(T0, 12)), added.itemId);

		ex.queueSuccess(80.0);
		await checkItem(makeDeps(ex, plusHours(T0, 24)), added.itemId);

		const stats = await getItemStats(
			makeDeps(ex, plusHours(T0, 25)),
			added.itemId,
		);

		expect(stats.current).toBe(8000);
		expect(stats.medianWindow).toBe(10000);
		expect(stats.percentVsTypical).toBeCloseTo(-20, 10);
		expect(stats.lowestEver).toBe(8000);
		expect(stats.highestEver).toBe(10000);
		expect(stats.totalSampleCount).toBe(3);
	});

	it("throws for an unknown item", async () => {
		const ex = fakeExtractor();
		await expect(
			getItemStats(makeDeps(ex, T0), "00000000-0000-0000-0000-000000000000"),
		).rejects.toBeInstanceOf(ItemNotFoundError);
	});
});

describe("findDueItems", () => {
	beforeEach(async () => {
		await resetTestDatabase();
	});

	it("returns only items whose next_check_at has passed, oldest first", async () => {
		const ex = fakeExtractor();

		ex.queueSuccess(10.0);
		const a = await addItem(makeDeps(ex, T0), "https://a.fi/1");
		ex.queueSuccess(10.0);
		const b = await addItem(makeDeps(ex, T0), "https://a.fi/2");

		// a is due earlier than b.
		await db
			.updateTable("items")
			.set({ next_check_at: plusHours(T0, 1) })
			.where("id", "=", a.itemId)
			.execute();
		await db
			.updateTable("items")
			.set({ next_check_at: plusHours(T0, 2) })
			.where("id", "=", b.itemId)
			.execute();

		const atThree = plusHours(T0, 3);
		const due = await findDueItems(makeDeps(ex, atThree), 10);
		expect(due.map((d) => d.id)).toEqual([a.itemId, b.itemId]);

		// At T0+90min only a is due.
		const early = await findDueItems(
			makeDeps(ex, new Date(T0.getTime() + 90 * 60 * 1000)),
			10,
		);
		expect(early.map((d) => d.id)).toEqual([a.itemId]);
	});

	it("excludes archived items", async () => {
		const ex = fakeExtractor();
		ex.queueSuccess(10.0);
		const a = await addItem(makeDeps(ex, T0), "https://a.fi/1");

		await db
			.updateTable("items")
			.set({ next_check_at: T0, archived_at: T0 })
			.where("id", "=", a.itemId)
			.execute();

		const due = await findDueItems(makeDeps(ex, plusHours(T0, 5)), 10);
		expect(due).toHaveLength(0);
	});

	it("respects the limit", async () => {
		const ex = fakeExtractor();
		for (let i = 0; i < 5; i++) {
			ex.queueSuccess(10.0);
			await addItem(makeDeps(ex, T0), `https://a.fi/${i}`);
		}

		await db.updateTable("items").set({ next_check_at: T0 }).execute();

		const due = await findDueItems(makeDeps(ex, plusHours(T0, 1)), 3);
		expect(due).toHaveLength(3);
	});
});

/**
 * The extractor contract says it returns ok:false rather than throwing, but a
 * network error, a DNS failure or a bug inside the module throws anyway.
 *
 * This was a real bug: an extractor that threw skipped checkItem's failure
 * branch entirely, so consecutive_failures never incremented and
 * next_check_at never advanced — the item stayed permanently due and was
 * retried on every scheduler run, exactly the hammering the backoff exists to
 * prevent. The fake extractor in the tests above only ever returned ok:false,
 * so nothing caught it.
 */
describe("a throwing extractor", () => {
	beforeEach(async () => {
		await resetTestDatabase();
	});

	function throwingDeps(message = "socket hang up"): ServiceDeps {
		return {
			db,
			extractPrice: async () => {
				throw new Error(message);
			},
		};
	}

	it("still saves the item when addItem's extractor throws", async () => {
		const result = await addItem(throwingDeps(), "https://a.example/1");

		expect(result.created).toBe(true);
		expect(result.extractFailing).toBe(true);
		expect(result.error).toBe("socket hang up");

		const saved = await db
			.selectFrom("items")
			.select(["url", "extract_failing", "consecutive_failures"])
			.executeTakeFirstOrThrow();

		expect(saved.url).toBe("https://a.example/1");
		expect(saved.extract_failing).toBe(true);
		expect(saved.consecutive_failures).toBe(1);
	});

	it("records failure state when checkItem's extractor throws", async () => {
		const added = await addItem(throwingDeps(), "https://a.example/1");

		const before = await db
			.selectFrom("items")
			.select("next_check_at")
			.where("id", "=", added.itemId)
			.executeTakeFirstOrThrow();

		const result = await checkItem(throwingDeps("ECONNREFUSED"), added.itemId);

		expect(result.ok).toBe(false);
		expect(result.error).toBe("ECONNREFUSED");
		expect(result.consecutiveFailures).toBe(2);

		const after = await db
			.selectFrom("items")
			.select(["extract_failing", "consecutive_failures", "next_check_at"])
			.where("id", "=", added.itemId)
			.executeTakeFirstOrThrow();

		expect(after.extract_failing).toBe(true);
		expect(after.consecutive_failures).toBe(2);
		// The whole point: the retry must be pushed further out each time.
		expect((after.next_check_at as Date).getTime()).toBeGreaterThan(
			(before.next_check_at as Date).getTime(),
		);
	});

	it("backs off further on each successive throw", async () => {
		const added = await addItem(throwingDeps(), "https://a.example/1");

		const delays: Array<number> = [];
		for (let i = 0; i < 3; i++) {
			await db
				.updateTable("items")
				.set({ next_check_at: new Date() })
				.where("id", "=", added.itemId)
				.execute();

			const at = Date.now();
			const result = await checkItem(throwingDeps(), added.itemId);
			delays.push(result.nextCheckAt.getTime() - at);
		}

		expect(delays[1]).toBeGreaterThan(delays[0] as number);
		expect(delays[2]).toBeGreaterThan(delays[1] as number);
	});

	it("writes no price_check row when the extractor throws", async () => {
		const added = await addItem(throwingDeps(), "https://a.example/1");
		await checkItem(throwingDeps(), added.itemId);

		const rows = await db.selectFrom("price_checks").selectAll().execute();

		expect(rows).toHaveLength(0);
	});

	it("reports a non-Error throw without serialising it to {}", async () => {
		const deps: ServiceDeps = {
			db,
			extractPrice: async () => {
				throw "just a string";
			},
		};

		const result = await addItem(deps, "https://a.example/1");

		expect(result.extractFailing).toBe(true);
		expect(result.error).toBe("extraction threw");
	});
});

describe("addItem — user-picked price selector", () => {
	beforeEach(async () => {
		await resetTestDatabase();
	});

	it("stores the selector and passes it to the extractor", async () => {
		const extractor = fakeExtractor();
		extractor.queueSuccess(14.99);

		const result = await addItem(
			makeDeps(extractor, T0),
			"https://a.example/1",
			{ priceSelector: '[data-test-id="price"]' },
		);

		expect(result.created).toBe(true);
		expect(extractor.callOptions[0]?.priceSelector).toBe(
			'[data-test-id="price"]',
		);

		const row = await db
			.selectFrom("items")
			.select(["price_selector", "price_selector_failing"])
			.where("id", "=", result.itemId)
			.executeTakeFirstOrThrow();

		expect(row.price_selector).toBe('[data-test-id="price"]');
		expect(row.price_selector_failing).toBe(false);
	});

	it("records an observed price WITHOUT calling the extractor", async () => {
		// The whole point on a bot-blocked store: the browser already saw the
		// price, so fetching again would fail or contradict it.
		const extractor = fakeExtractor();

		const result = await addItem(
			makeDeps(extractor, T0),
			"https://a.example/1",
			{ priceSelector: ".price", observedPrice: 14.99 },
		);

		expect(extractor.calls).toHaveLength(0);
		expect(result.extractFailing).toBe(false);
		// MAJOR units in, integer MINOR units stored.
		expect(result.price).toBe(1499);

		const checks = await db
			.selectFrom("price_checks")
			.select(["price", "availability"])
			.where("item_id", "=", result.itemId)
			.execute();

		expect(checks).toHaveLength(1);
		expect(checks[0]?.price).toBe(1499);
	});

	it("converts an observed price with Finnish decimals correctly", async () => {
		const extractor = fakeExtractor();

		const result = await addItem(
			makeDeps(extractor, T0),
			"https://a.example/1",
			{ observedPrice: 1299, observedCurrency: "EUR" },
		);

		expect(result.price).toBe(129900);
	});

	it("stores observed currency and availability", async () => {
		const extractor = fakeExtractor();

		const result = await addItem(
			makeDeps(extractor, T0),
			"https://a.example/1",
			{
				observedPrice: 9.9,
				observedCurrency: "EUR",
				observedAvailability: "out_of_stock",
			},
		);

		const item = await db
			.selectFrom("items")
			.select(["currency", "extract_method"])
			.where("id", "=", result.itemId)
			.executeTakeFirstOrThrow();

		expect(item.currency).toBe("EUR");
		expect(item.extract_method).toBe("selector");

		const check = await db
			.selectFrom("price_checks")
			.select("availability")
			.where("item_id", "=", result.itemId)
			.executeTakeFirstOrThrow();

		expect(check.availability).toBe("out_of_stock");
	});

	it("updates the selector when re-adding an already tracked URL", async () => {
		// Re-picking a broken selector goes through this path; dropping it would
		// make the picker appear to do nothing on the items it exists to fix.
		const extractor = fakeExtractor();
		extractor.queueSuccess(10);

		const first = await addItem(
			makeDeps(extractor, T0),
			"https://a.example/1",
			{
				priceSelector: ".old",
			},
		);

		const second = await addItem(
			makeDeps(extractor, T0),
			"https://a.example/1",
			{ priceSelector: ".new" },
		);

		expect(second.created).toBe(false);
		expect(second.itemId).toBe(first.itemId);

		const row = await db
			.selectFrom("items")
			.select(["price_selector", "price_selector_failing"])
			.where("id", "=", first.itemId)
			.executeTakeFirstOrThrow();

		expect(row.price_selector).toBe(".new");
		expect(row.price_selector_failing).toBe(false);
	});

	it("leaves the selector untouched when re-adding without one", async () => {
		const extractor = fakeExtractor();
		extractor.queueSuccess(10);

		const first = await addItem(
			makeDeps(extractor, T0),
			"https://a.example/1",
			{
				priceSelector: ".keep",
			},
		);

		await addItem(makeDeps(extractor, T0), "https://a.example/1");

		const row = await db
			.selectFrom("items")
			.select("price_selector")
			.where("id", "=", first.itemId)
			.executeTakeFirstOrThrow();

		expect(row.price_selector).toBe(".keep");
	});

	it("records no price_checks row when an observed price is absent and extraction fails", async () => {
		const extractor = fakeExtractor();
		extractor.queueFailure();

		const result = await addItem(
			makeDeps(extractor, T0),
			"https://a.example/1",
			{ priceSelector: ".p" },
		);

		expect(result.extractFailing).toBe(true);

		const checks = await db.selectFrom("price_checks").selectAll().execute();

		// The standing invariant: price_checks is a pure record of observed
		// prices, never a null or sentinel standing in for a failure.
		expect(checks).toHaveLength(0);
	});
});

describe("checkItem — user-picked price selector", () => {
	beforeEach(async () => {
		await resetTestDatabase();
	});

	it("passes the stored selector to the extractor", async () => {
		const extractor = fakeExtractor();
		extractor.queueSuccess(10);
		extractor.queueSuccess(9);

		const added = await addItem(
			makeDeps(extractor, T0),
			"https://a.example/1",
			{
				priceSelector: ".stored",
			},
		);

		await checkItem(makeDeps(extractor, plusHours(T0, 13)), added.itemId);

		expect(extractor.callOptions[1]?.priceSelector).toBe(".stored");
	});

	it("flags a selector that stopped matching, while keeping the item working", async () => {
		const extractor = fakeExtractor();
		extractor.queueSuccess(10);
		// The cascade rescued the price, but the user's selector missed.
		extractor.queueSuccess(9, { userSelectorFailed: true, method: "json-ld" });

		const added = await addItem(
			makeDeps(extractor, T0),
			"https://a.example/1",
			{
				priceSelector: ".gone",
			},
		);

		const checked = await checkItem(
			makeDeps(extractor, plusHours(T0, 13)),
			added.itemId,
		);

		expect(checked.ok).toBe(true);
		expect(checked.price).toBe(900);

		const row = await db
			.selectFrom("items")
			.select(["price_selector_failing", "extract_failing"])
			.where("id", "=", added.itemId)
			.executeTakeFirstOrThrow();

		// Flagged for a re-pick, but NOT failing — the price still arrived.
		expect(row.price_selector_failing).toBe(true);
		expect(row.extract_failing).toBe(false);
	});

	it("clears the flag once the selector matches again", async () => {
		const extractor = fakeExtractor();
		extractor.queueSuccess(10);
		extractor.queueSuccess(9, { userSelectorFailed: true, method: "json-ld" });
		extractor.queueSuccess(8, { method: "selector" });

		const added = await addItem(
			makeDeps(extractor, T0),
			"https://a.example/1",
			{
				priceSelector: ".flaky",
			},
		);

		await checkItem(makeDeps(extractor, plusHours(T0, 13)), added.itemId);
		await checkItem(makeDeps(extractor, plusHours(T0, 26)), added.itemId);

		const row = await db
			.selectFrom("items")
			.select("price_selector_failing")
			.where("id", "=", added.itemId)
			.executeTakeFirstOrThrow();

		expect(row.price_selector_failing).toBe(false);
	});

	it("never sets the flag on an item that has no selector", async () => {
		const extractor = fakeExtractor();
		extractor.queueSuccess(10);
		extractor.queueSuccess(9);

		const added = await addItem(makeDeps(extractor, T0), "https://a.example/1");

		await checkItem(makeDeps(extractor, plusHours(T0, 13)), added.itemId);

		const row = await db
			.selectFrom("items")
			.select(["price_selector", "price_selector_failing"])
			.where("id", "=", added.itemId)
			.executeTakeFirstOrThrow();

		expect(row.price_selector).toBeNull();
		expect(row.price_selector_failing).toBe(false);
	});
});
