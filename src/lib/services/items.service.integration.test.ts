import { beforeEach, describe, expect, it } from "vitest";
import { db } from "~/lib/db";
import type { PriceResult } from "~/lib/extraction/types";
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

	return {
		calls,
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
		fn: async (url: string): Promise<PriceResult> => {
			calls.push(url);
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
