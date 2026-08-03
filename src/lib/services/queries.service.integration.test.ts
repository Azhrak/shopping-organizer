import { beforeEach, describe, expect, it } from "vitest";
import { db } from "~/lib/db";
import { resetTestDatabase } from "~/test/db";
import {
	getItemDetail,
	getSmartFilterCounts,
	listItems,
} from "./queries.service";

/**
 * Read-model behaviour that the catalog design depends on: the struck-through
 * previous price, the sidebar's saved views, and the card sparklines.
 *
 * These use direct inserts rather than addItem/checkItem so each test controls
 * exact prices and timestamps — the filters are defined in terms of ordering
 * and recency, which a service-driven fixture cannot pin down precisely.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

async function makeItem(
	url: string,
	overrides: {
		targetPrice?: number | null;
		folder?: string;
		archived?: boolean;
		title?: string;
	} = {},
): Promise<string> {
	const row = await db
		.insertInto("items")
		.values({
			url,
			store_hostname: new URL(url).hostname,
			title: overrides.title ?? `Item ${url}`,
			folder: overrides.folder ?? "inbox",
			target_price: overrides.targetPrice ?? null,
			archived_at: overrides.archived ? new Date() : null,
		})
		.returning("id")
		.executeTakeFirstOrThrow();

	return row.id;
}

/** Append price observations, oldest first, spaced one day apart. */
async function addHistory(
	itemId: string,
	prices: Array<number>,
	options: { endingDaysAgo?: number } = {},
): Promise<void> {
	const endingDaysAgo = options.endingDaysAgo ?? 0;
	const now = Date.now();

	for (const [index, price] of prices.entries()) {
		const daysAgo = endingDaysAgo + (prices.length - 1 - index);
		await db
			.insertInto("price_checks")
			.values({
				item_id: itemId,
				price,
				availability: "in_stock",
				checked_at: new Date(now - daysAgo * DAY_MS),
			})
			.execute();
	}
}

describe("listItems — previousPrice", () => {
	beforeEach(async () => {
		await resetTestDatabase();
	});

	it("is null when the item has never been checked", async () => {
		await makeItem("https://a.example/1");

		const [entry] = await listItems(db);

		expect(entry?.currentPrice).toBeNull();
		expect(entry?.previousPrice).toBeNull();
	});

	it("is null when the item has exactly one check", async () => {
		const id = await makeItem("https://a.example/1");
		await addHistory(id, [5000]);

		const [entry] = await listItems(db);

		expect(entry?.currentPrice).toBe(5000);
		expect(entry?.previousPrice).toBeNull();
	});

	it("is the observation directly before the latest one", async () => {
		const id = await makeItem("https://a.example/1");
		await addHistory(id, [7000, 6000, 5000]);

		const [entry] = await listItems(db);

		expect(entry?.currentPrice).toBe(5000);
		expect(entry?.previousPrice).toBe(6000);
	});

	it("is higher than current after a rise, not just after a drop", async () => {
		const id = await makeItem("https://a.example/1");
		await addHistory(id, [4000, 9000]);

		const [entry] = await listItems(db);

		expect(entry?.currentPrice).toBe(9000);
		expect(entry?.previousPrice).toBe(4000);
	});

	it("does not leak another item's prices", async () => {
		const a = await makeItem("https://a.example/1");
		const b = await makeItem("https://b.example/1");
		await addHistory(a, [1000, 900]);
		await addHistory(b, [8000, 7000]);

		const entries = await listItems(db);
		const byUrl = new Map(entries.map((e) => [e.url, e]));

		expect(byUrl.get("https://a.example/1")?.previousPrice).toBe(1000);
		expect(byUrl.get("https://b.example/1")?.previousPrice).toBe(8000);
	});
});

describe("listItems — sparkline", () => {
	beforeEach(async () => {
		await resetTestDatabase();
	});

	it("is empty for an item with no history", async () => {
		await makeItem("https://a.example/1");

		const [entry] = await listItems(db);

		expect(entry?.sparkline).toEqual([]);
	});

	it("returns prices oldest-first so the line reads left to right", async () => {
		const id = await makeItem("https://a.example/1");
		await addHistory(id, [100, 200, 300]);

		const [entry] = await listItems(db);

		expect(entry?.sparkline).toEqual([100, 200, 300]);
	});

	it("caps at the newest 12 points", async () => {
		const id = await makeItem("https://a.example/1");
		const prices = Array.from({ length: 20 }, (_, i) => 1000 + i);
		await addHistory(id, prices);

		const [entry] = await listItems(db);

		expect(entry?.sparkline).toHaveLength(12);
		// The newest 12 of 1000..1019 are 1008..1019.
		expect(entry?.sparkline[0]).toBe(1008);
		expect(entry?.sparkline.at(-1)).toBe(1019);
	});

	it("keeps each item's series separate", async () => {
		const a = await makeItem("https://a.example/1");
		const b = await makeItem("https://b.example/1");
		await addHistory(a, [10, 20]);
		await addHistory(b, [90, 80, 70]);

		const entries = await listItems(db);
		const byUrl = new Map(entries.map((e) => [e.url, e]));

		expect(byUrl.get("https://a.example/1")?.sparkline).toEqual([10, 20]);
		expect(byUrl.get("https://b.example/1")?.sparkline).toEqual([90, 80, 70]);
	});
});

describe("listItems — smart filter: at_target", () => {
	beforeEach(async () => {
		await resetTestDatabase();
	});

	it("excludes items with no target price", async () => {
		const id = await makeItem("https://a.example/1", { targetPrice: null });
		await addHistory(id, [1000]);

		const entries = await listItems(db, { smartFilter: "at_target" });

		expect(entries).toHaveLength(0);
	});

	it("excludes items that have never been checked", async () => {
		await makeItem("https://a.example/1", { targetPrice: 5000 });

		const entries = await listItems(db, { smartFilter: "at_target" });

		expect(entries).toHaveLength(0);
	});

	it("includes an item priced below its target", async () => {
		const id = await makeItem("https://a.example/1", { targetPrice: 5000 });
		await addHistory(id, [4999]);

		const entries = await listItems(db, { smartFilter: "at_target" });

		expect(entries).toHaveLength(1);
	});

	it("includes an item priced exactly at its target", async () => {
		const id = await makeItem("https://a.example/1", { targetPrice: 5000 });
		await addHistory(id, [5000]);

		const entries = await listItems(db, { smartFilter: "at_target" });

		expect(entries).toHaveLength(1);
	});

	it("excludes an item one cent above its target", async () => {
		const id = await makeItem("https://a.example/1", { targetPrice: 5000 });
		await addHistory(id, [5001]);

		const entries = await listItems(db, { smartFilter: "at_target" });

		expect(entries).toHaveLength(0);
	});

	it("judges on the latest price, not an older one that was below target", async () => {
		const id = await makeItem("https://a.example/1", { targetPrice: 5000 });
		// Was below target, then rose back above it.
		await addHistory(id, [4000, 6000]);

		const entries = await listItems(db, { smartFilter: "at_target" });

		expect(entries).toHaveLength(0);
	});
});

describe("listItems — smart filter: dropped", () => {
	beforeEach(async () => {
		await resetTestDatabase();
	});

	it("excludes an item with a single check", async () => {
		const id = await makeItem("https://a.example/1");
		await addHistory(id, [5000]);

		const entries = await listItems(db, { smartFilter: "dropped" });

		expect(entries).toHaveLength(0);
	});

	it("includes an item whose latest price is below its predecessor", async () => {
		const id = await makeItem("https://a.example/1");
		await addHistory(id, [6000, 5000]);

		const entries = await listItems(db, { smartFilter: "dropped" });

		expect(entries).toHaveLength(1);
	});

	it("excludes an item whose latest price rose", async () => {
		const id = await makeItem("https://a.example/1");
		await addHistory(id, [5000, 6000]);

		const entries = await listItems(db, { smartFilter: "dropped" });

		expect(entries).toHaveLength(0);
	});

	it("excludes an unchanged price", async () => {
		const id = await makeItem("https://a.example/1");
		await addHistory(id, [5000, 5000]);

		const entries = await listItems(db, { smartFilter: "dropped" });

		expect(entries).toHaveLength(0);
	});

	it("excludes a drop older than the window", async () => {
		const id = await makeItem("https://a.example/1");
		// Latest observation is 30 days old.
		await addHistory(id, [6000, 5000], { endingDaysAgo: 30 });

		const entries = await listItems(db, { smartFilter: "dropped" });

		expect(entries).toHaveLength(0);
	});

	it("includes a drop inside a widened window", async () => {
		const id = await makeItem("https://a.example/1");
		await addHistory(id, [6000, 5000], { endingDaysAgo: 30 });

		const entries = await listItems(db, {
			smartFilter: "dropped",
			droppedWindowDays: 60,
		});

		expect(entries).toHaveLength(1);
	});

	it("ignores a price that dropped and then recovered", async () => {
		const id = await makeItem("https://a.example/1");
		// Fell to 4000, then back up to 5500. Latest > predecessor, so not a drop
		// even though a drop happened inside the window.
		await addHistory(id, [6000, 4000, 5500]);

		const entries = await listItems(db, { smartFilter: "dropped" });

		expect(entries).toHaveLength(0);
	});

	it("combines with a folder filter", async () => {
		const a = await makeItem("https://a.example/1", { folder: "shoes" });
		const b = await makeItem("https://b.example/1", { folder: "outdoor" });
		await addHistory(a, [6000, 5000]);
		await addHistory(b, [6000, 5000]);

		const entries = await listItems(db, {
			smartFilter: "dropped",
			folder: "shoes",
		});

		expect(entries).toHaveLength(1);
		expect(entries[0]?.folder).toBe("shoes");
	});

	it("excludes archived items by default", async () => {
		const id = await makeItem("https://a.example/1", { archived: true });
		await addHistory(id, [6000, 5000]);

		const entries = await listItems(db, { smartFilter: "dropped" });

		expect(entries).toHaveLength(0);
	});
});

describe("getSmartFilterCounts", () => {
	beforeEach(async () => {
		await resetTestDatabase();
	});

	it("reports zeroes on an empty database", async () => {
		expect(await getSmartFilterCounts(db)).toEqual({
			dropped: 0,
			atTarget: 0,
			archived: 0,
		});
	});

	it("counts each view independently", async () => {
		const dropped = await makeItem("https://a.example/1");
		await addHistory(dropped, [6000, 5000]);

		const atTarget = await makeItem("https://b.example/1", {
			targetPrice: 9000,
		});
		await addHistory(atTarget, [8000]);

		const archived = await makeItem("https://c.example/1", { archived: true });
		await addHistory(archived, [1000]);

		expect(await getSmartFilterCounts(db)).toEqual({
			dropped: 1,
			atTarget: 1,
			archived: 1,
		});
	});

	it("counts an item that is both dropped and at target in both views", async () => {
		const id = await makeItem("https://a.example/1", { targetPrice: 5500 });
		await addHistory(id, [6000, 5000]);

		expect(await getSmartFilterCounts(db)).toMatchObject({
			dropped: 1,
			atTarget: 1,
		});
	});

	it("agrees with the list it labels", async () => {
		for (let i = 0; i < 3; i++) {
			const id = await makeItem(`https://s${i}.example/1`);
			await addHistory(id, [6000, 5000 - i]);
		}

		const counts = await getSmartFilterCounts(db);
		const list = await listItems(db, { smartFilter: "dropped" });

		expect(counts.dropped).toBe(list.length);
	});
});

describe("listItems — percentVsTypical", () => {
	beforeEach(async () => {
		await resetTestDatabase();
	});

	it("is null with no history", async () => {
		await makeItem("https://a.example/1");

		const [entry] = await listItems(db);

		expect(entry?.percentVsTypical).toBeNull();
	});

	it("is zero when the current price equals its typical price", async () => {
		const id = await makeItem("https://a.example/1");
		await addHistory(id, [1000, 1000, 1000]);

		const [entry] = await listItems(db);

		expect(entry?.percentVsTypical).toBeCloseTo(0, 6);
	});

	it("is negative when cheaper than typical", async () => {
		const id = await makeItem("https://a.example/1");
		// Median of [1000,1000,1000,500] interpolates to 1000.
		await addHistory(id, [1000, 1000, 1000, 500]);

		const [entry] = await listItems(db);

		expect(entry?.percentVsTypical).toBeLessThan(0);
		expect(entry?.percentVsTypical).toBeCloseTo(-50, 6);
	});

	it("is positive when dearer than typical", async () => {
		const id = await makeItem("https://a.example/1");
		await addHistory(id, [100, 100, 100, 200]);

		const [entry] = await listItems(db);

		expect(entry?.percentVsTypical).toBeGreaterThan(0);
	});

	/**
	 * The SQL median and computeStats' median are two implementations of one
	 * definition. If they ever disagree, a catalog badge and the detail page
	 * would show different numbers for the same item — a wrong answer that
	 * still looks entirely plausible.
	 */
	it("matches the detail view's computeStats figure exactly", async () => {
		const series = [
			[1000, 900, 800],
			[500, 500, 400, 300],
			[2000, 1000],
			[777, 651, 942, 383, 1200],
			[100, 100, 100, 100, 100, 99],
		];

		for (const [index, prices] of series.entries()) {
			const id = await makeItem(`https://s${index}.example/1`);
			await addHistory(id, prices);
		}

		const entries = await listItems(db);

		for (const entry of entries) {
			const detail = await getItemDetail(db, entry.id);

			expect(detail?.stats.percentVsTypical).not.toBeNull();
			expect(entry.percentVsTypical).toBeCloseTo(
				detail?.stats.percentVsTypical as number,
				6,
			);
		}
	});

	it("ignores observations outside the 90-day window", async () => {
		const id = await makeItem("https://a.example/1");
		// Very old expensive prices must not drag the typical price up.
		await addHistory(id, [9000, 9000], { endingDaysAgo: 200 });
		await addHistory(id, [1000, 1000]);

		const [entry] = await listItems(db);
		const detail = await getItemDetail(db, id);

		expect(entry?.percentVsTypical).toBeCloseTo(
			detail?.stats.percentVsTypical as number,
			6,
		);
		expect(entry?.percentVsTypical).toBeCloseTo(0, 6);
	});
});

describe("getItemDetail — previousPrice", () => {
	beforeEach(async () => {
		await resetTestDatabase();
	});

	it("is null with a single observation", async () => {
		const id = await makeItem("https://a.example/1");
		await addHistory(id, [5000]);

		const detail = await getItemDetail(db, id);

		expect(detail?.previousPrice).toBeNull();
	});

	it("is the observation before the current one", async () => {
		const id = await makeItem("https://a.example/1");
		await addHistory(id, [7000, 6000, 5000]);

		const detail = await getItemDetail(db, id);

		expect(detail?.stats.current).toBe(5000);
		expect(detail?.previousPrice).toBe(6000);
	});
});
