import { beforeEach, describe, expect, it } from "vitest";
import { db } from "~/lib/db";
import type { PriceResult } from "~/lib/extraction/types";
import { resetTestDatabase } from "~/test/db";
import { addItem, type ServiceDeps } from "./items.service";
import { checkAllDue } from "./scheduler.service";

/**
 * Scheduler behaviour against a real Postgres.
 *
 * The extractor is driven per-URL rather than from a shared queue: a run
 * checks several items concurrently, so a FIFO queue would hand results to
 * whichever worker happened to arrive first and make assertions
 * order-dependent.
 */
function fakeExtractor() {
	const byUrl = new Map<string, PriceResult>();
	const calls: Array<{ url: string; at: number }> = [];
	let concurrent = 0;
	let peakConcurrent = 0;
	let delayMs = 0;

	function base(url: string): PriceResult {
		return {
			ok: true,
			url,
			price: null,
			currency: "EUR",
			title: "Test Product",
			image: null,
			availability: "in_stock",
			method: "json-ld",
		};
	}

	return {
		calls,
		get peakConcurrent() {
			return peakConcurrent;
		},
		setDelay(ms: number) {
			delayMs = ms;
		},
		/**
		 * Forget everything recorded during seeding, so assertions about a run
		 * see only that run's calls. Seeding goes through addItem, which invokes
		 * the extractor once per item.
		 */
		resetTracking() {
			calls.length = 0;
			peakConcurrent = 0;
		},
		/** Clear a configured result so the extractor throws for this URL. */
		clear(url: string) {
			byUrl.delete(url);
		},
		/** `price` is in MAJOR units — the extractor contract, same as the real one. */
		setPrice(url: string, price: number) {
			byUrl.set(url, { ...base(url), price });
		},
		setFailure(url: string, error = "no price found") {
			byUrl.set(url, {
				...base(url),
				ok: false,
				price: null,
				currency: null,
				title: null,
				availability: "unknown",
				method: null,
				error,
			});
		},
		fn: async (url: string): Promise<PriceResult> => {
			concurrent++;
			peakConcurrent = Math.max(peakConcurrent, concurrent);
			calls.push({ url, at: Date.now() });

			if (delayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, delayMs));
			}

			concurrent--;

			const result = byUrl.get(url);
			if (!result) {
				throw new Error(`fakeExtractor: no result configured for ${url}`);
			}
			return result;
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

/**
 * Save an item and force it due, bypassing the freshly-added interval.
 *
 * `initialPrice` is in MAJOR units, like every other extractor input.
 */
async function seedDueItem(
	deps: ServiceDeps,
	extractor: ReturnType<typeof fakeExtractor>,
	url: string,
	initialPrice: number,
): Promise<string> {
	extractor.setPrice(url, initialPrice);
	const added = await addItem(deps, url);

	await db
		.updateTable("items")
		.set({ next_check_at: new Date(Date.now() - 60_000) })
		.where("id", "=", added.itemId)
		.execute();

	return added.itemId;
}

describe("checkAllDue", () => {
	beforeEach(async () => {
		await resetTestDatabase();
	});

	it("reports an empty run when nothing is due", async () => {
		const extractor = fakeExtractor();
		const summary = await checkAllDue(makeDeps(extractor), {
			perHostDelayMs: 0,
		});

		expect(summary.attempted).toBe(0);
		expect(summary.succeeded).toBe(0);
		expect(summary.failed).toBe(0);
		expect(summary.entries).toEqual([]);
		expect(extractor.calls).toHaveLength(0);
	});

	it("skips items that are not yet due", async () => {
		const extractor = fakeExtractor();
		const deps = makeDeps(extractor);

		extractor.setPrice("https://example.com/fresh", 1000);
		await addItem(deps, "https://example.com/fresh");

		// addItem schedules the next check 12h out, so nothing is due yet.
		const summary = await checkAllDue(deps, { perHostDelayMs: 0 });

		expect(summary.attempted).toBe(0);
	});

	it("skips archived items", async () => {
		const extractor = fakeExtractor();
		const deps = makeDeps(extractor);

		const itemId = await seedDueItem(
			deps,
			extractor,
			"https://example.com/archived",
			10,
		);
		await db
			.updateTable("items")
			.set({ archived_at: new Date() })
			.where("id", "=", itemId)
			.execute();

		const summary = await checkAllDue(deps, { perHostDelayMs: 0 });

		expect(summary.attempted).toBe(0);
	});

	it("checks every due item and appends price history", async () => {
		const extractor = fakeExtractor();
		const deps = makeDeps(extractor);

		const urls = [
			"https://a-store.example/one",
			"https://b-store.example/two",
			"https://c-store.example/three",
		];
		for (const url of urls) {
			await seedDueItem(deps, extractor, url, 50);
		}

		// Second observation, a different price.
		for (const url of urls) {
			extractor.setPrice(url, 40);
		}
		extractor.resetTracking();

		const summary = await checkAllDue(deps, { perHostDelayMs: 0 });

		expect(summary.attempted).toBe(3);
		expect(summary.succeeded).toBe(3);
		expect(summary.failed).toBe(0);

		const rows = await db
			.selectFrom("price_checks")
			.select(["price"])
			.execute();

		// Three items x (one row from addItem + one from this run). Prices are
		// stored in minor units: 40.00 EUR -> 4000.
		expect(rows).toHaveLength(6);
		expect(rows.filter((r) => r.price === 4000)).toHaveLength(3);
	});

	it("counts drop events", async () => {
		const extractor = fakeExtractor();
		const deps = makeDeps(extractor);

		const url = "https://drop-store.example/item";
		const itemId = await seedDueItem(deps, extractor, url, 100);

		// target_price is stored in minor units: 90.00 EUR.
		await db
			.updateTable("items")
			.set({ target_price: 9000 })
			.where("id", "=", itemId)
			.execute();

		extractor.setPrice(url, 80);

		const summary = await checkAllDue(deps, { perHostDelayMs: 0 });

		expect(summary.drops).toBe(1);
		expect(summary.entries[0]?.isDrop).toBe(true);
	});

	it("keeps going when one item's extraction fails", async () => {
		const extractor = fakeExtractor();
		const deps = makeDeps(extractor);

		const good = "https://good.example/item";
		const bad = "https://bad.example/item";
		await seedDueItem(deps, extractor, good, 50);
		await seedDueItem(deps, extractor, bad, 50);

		extractor.setPrice(good, 45);
		extractor.setFailure(bad, "404");
		extractor.resetTracking();

		const summary = await checkAllDue(deps, { perHostDelayMs: 0 });

		expect(summary.attempted).toBe(2);
		expect(summary.succeeded).toBe(1);
		expect(summary.failed).toBe(1);

		const failedEntry = summary.entries.find((e) => !e.ok);
		expect(failedEntry?.error).toBe("404");

		// The good item still recorded its new price.
		const prices = await db
			.selectFrom("price_checks")
			.innerJoin("items", "items.id", "price_checks.item_id")
			.select(["price_checks.price"])
			.where("items.url", "=", good)
			.execute();
		expect(prices.map((p) => p.price).sort()).toEqual([4500, 5000]);
	});

	it("marks the failing item and leaves the healthy one clean", async () => {
		const extractor = fakeExtractor();
		const deps = makeDeps(extractor);

		const good = "https://healthy.example/item";
		const bad = "https://broken.example/item";
		const goodId = await seedDueItem(deps, extractor, good, 50);
		const badId = await seedDueItem(deps, extractor, bad, 50);

		extractor.setPrice(good, 45);
		extractor.setFailure(bad, "410 gone");

		await checkAllDue(deps, { perHostDelayMs: 0 });

		const rows = await db
			.selectFrom("items")
			.select(["id", "extract_failing", "consecutive_failures"])
			.execute();

		const goodRow = rows.find((r) => r.id === goodId);
		const badRow = rows.find((r) => r.id === badId);

		expect(goodRow?.extract_failing).toBe(false);
		expect(goodRow?.consecutive_failures).toBe(0);
		expect(badRow?.extract_failing).toBe(true);
		expect(badRow?.consecutive_failures).toBe(1);
	});

	it("keeps going when the extractor throws outright", async () => {
		const extractor = fakeExtractor();
		const deps = makeDeps(extractor);

		const good = "https://ok.example/item";
		const thrower = "https://throws.example/item";
		await seedDueItem(deps, extractor, good, 50);
		await seedDueItem(deps, extractor, thrower, 50);

		extractor.setPrice(good, 45);
		// Drop the seeded result so the extractor throws on this URL, standing in
		// for a non-PriceResult failure (a DNS error, say) rather than an ok:false.
		extractor.clear(thrower);
		extractor.resetTracking();

		const summary = await checkAllDue(deps, { perHostDelayMs: 0 });

		expect(summary.attempted).toBe(2);
		expect(summary.succeeded).toBe(1);
		expect(summary.failed).toBe(1);
		expect(summary.entries.find((e) => !e.ok)?.error).toContain(
			"no result configured",
		);
	});

	it("records failure state and backs off the next check", async () => {
		const extractor = fakeExtractor();
		const deps = makeDeps(extractor);

		const url = "https://failing.example/item";
		const itemId = await seedDueItem(deps, extractor, url, 5000);
		extractor.setFailure(url);

		await checkAllDue(deps, { perHostDelayMs: 0 });

		const item = await db
			.selectFrom("items")
			.select(["extract_failing", "consecutive_failures", "next_check_at"])
			.where("id", "=", itemId)
			.executeTakeFirstOrThrow();

		expect(item.extract_failing).toBe(true);
		expect(item.consecutive_failures).toBe(1);
		// Backoff pushed it into the future, so it is no longer due.
		expect((item.next_check_at as Date).getTime()).toBeGreaterThan(Date.now());

		const second = await checkAllDue(deps, { perHostDelayMs: 0 });
		expect(second.attempted).toBe(0);
	});

	it("honours the limit and takes the oldest due items first", async () => {
		const extractor = fakeExtractor();
		const deps = makeDeps(extractor);

		const oldest = "https://s1.example/oldest";
		const middle = "https://s2.example/middle";
		const newest = "https://s3.example/newest";

		const oldestId = await seedDueItem(deps, extractor, oldest, 1000);
		const middleId = await seedDueItem(deps, extractor, middle, 1000);
		const newestId = await seedDueItem(deps, extractor, newest, 1000);

		const base = Date.now();
		await db
			.updateTable("items")
			.set({ next_check_at: new Date(base - 300_000) })
			.where("id", "=", oldestId)
			.execute();
		await db
			.updateTable("items")
			.set({ next_check_at: new Date(base - 200_000) })
			.where("id", "=", middleId)
			.execute();
		await db
			.updateTable("items")
			.set({ next_check_at: new Date(base - 100_000) })
			.where("id", "=", newestId)
			.execute();

		for (const url of [oldest, middle, newest]) {
			extractor.setPrice(url, 900);
		}

		const summary = await checkAllDue(deps, { limit: 2, perHostDelayMs: 0 });

		expect(summary.attempted).toBe(2);
		expect(summary.entries.map((e) => e.url).sort()).toEqual(
			[oldest, middle].sort(),
		);
	});

	it("respects the concurrency cap", async () => {
		const extractor = fakeExtractor();
		const deps = makeDeps(extractor);

		for (let i = 0; i < 8; i++) {
			const url = `https://store-${i}.example/item`;
			await seedDueItem(deps, extractor, url, 1000);
			extractor.setPrice(url, 900);
		}

		extractor.setDelay(5);
		extractor.resetTracking();

		await checkAllDue(deps, { concurrency: 3, perHostDelayMs: 0 });

		expect(extractor.peakConcurrent).toBeLessThanOrEqual(3);
		// Guard against the cap passing trivially because nothing overlapped.
		expect(extractor.peakConcurrent).toBeGreaterThan(1);
	});

	it("serialises requests to the same hostname with a delay between them", async () => {
		const extractor = fakeExtractor();
		const deps = makeDeps(extractor);

		// Three items on ONE host: the per-host gate must space them out even
		// though the concurrency cap would allow them to run together.
		for (let i = 0; i < 3; i++) {
			const url = `https://same-host.example/item-${i}`;
			await seedDueItem(deps, extractor, url, 1000);
			extractor.setPrice(url, 900);
		}

		extractor.resetTracking();

		await checkAllDue(deps, { concurrency: 4, perHostDelayMs: 40 });

		expect(extractor.calls).toHaveLength(3);
		// Never two in flight at once against the same host.
		expect(extractor.peakConcurrent).toBe(1);

		const timestamps = extractor.calls.map((c) => c.at).sort((a, b) => a - b);
		for (let i = 1; i < timestamps.length; i++) {
			const gap = (timestamps[i] as number) - (timestamps[i - 1] as number);
			// Allow slack for timer granularity, but the gap must clearly exist.
			expect(gap).toBeGreaterThanOrEqual(30);
		}
	});

	it("still runs different hostnames in parallel", async () => {
		const extractor = fakeExtractor();
		const deps = makeDeps(extractor);

		for (let i = 0; i < 4; i++) {
			const url = `https://host-${i}.example/item`;
			await seedDueItem(deps, extractor, url, 1000);
			extractor.setPrice(url, 900);
		}

		extractor.setDelay(20);
		extractor.resetTracking();

		const started = Date.now();
		await checkAllDue(deps, { concurrency: 4, perHostDelayMs: 40 });
		const elapsed = Date.now() - started;

		expect(extractor.peakConcurrent).toBeGreaterThan(1);
		// Serial execution would cost at least 4 x (20ms + 40ms) = 240ms.
		expect(elapsed).toBeLessThan(200);
	});

	it("reports a coherent timing window", async () => {
		const extractor = fakeExtractor();
		const deps = makeDeps(extractor);

		const url = "https://timing.example/item";
		await seedDueItem(deps, extractor, url, 1000);
		extractor.setPrice(url, 900);

		const summary = await checkAllDue(deps, { perHostDelayMs: 0 });

		expect(summary.finishedAt.getTime()).toBeGreaterThanOrEqual(
			summary.startedAt.getTime(),
		);
	});
});
