import { beforeEach, describe, expect, it } from "vitest";
import { db } from "~/lib/db";
import { resetTestDatabase } from "~/test/db";

/**
 * Smoke tests for the initial schema. These assert the constraints the service
 * layer will rely on, so a future migration that silently drops one fails here
 * rather than in production.
 */
describe("001_initial schema", () => {
	beforeEach(async () => {
		await resetTestDatabase();
	});

	it("stores prices as integer minor units and reads them back as numbers", async () => {
		const item = await db
			.insertInto("items")
			.values({ url: "https://verkkokauppa.com/x", store_hostname: "verkkokauppa.com" })
			.returning("id")
			.executeTakeFirstOrThrow();

		await db
			.insertInto("price_checks")
			.values({ item_id: item.id, price: 129900, availability: "in_stock" })
			.execute();

		const row = await db
			.selectFrom("price_checks")
			.select(["price", "availability"])
			.where("item_id", "=", item.id)
			.executeTakeFirstOrThrow();

		expect(row.price).toBe(129900);
		expect(typeof row.price).toBe("number");
		expect(row.availability).toBe("in_stock");
	});

	it("applies defaults: folder, extract_failing, consecutive_failures, next_check_at", async () => {
		const item = await db
			.insertInto("items")
			.values({ url: "https://a.fi/1", store_hostname: "a.fi" })
			.returningAll()
			.executeTakeFirstOrThrow();

		expect(item.folder).toBe("inbox");
		expect(item.extract_failing).toBe(false);
		expect(item.consecutive_failures).toBe(0);
		expect(item.next_check_at).toBeInstanceOf(Date);
		expect(item.archived_at).toBeNull();
		expect(item.last_alert_price).toBeNull();
	});

	it("rejects a duplicate url", async () => {
		await db
			.insertInto("items")
			.values({ url: "https://a.fi/1", store_hostname: "a.fi" })
			.execute();

		await expect(
			db
				.insertInto("items")
				.values({ url: "https://a.fi/1", store_hostname: "a.fi" })
				.execute(),
		).rejects.toThrow(/items_url_key/);
	});

	it("rejects a negative price and a zero target_price", async () => {
		const item = await db
			.insertInto("items")
			.values({ url: "https://a.fi/1", store_hostname: "a.fi" })
			.returning("id")
			.executeTakeFirstOrThrow();

		await expect(
			db
				.insertInto("price_checks")
				.values({ item_id: item.id, price: -1 })
				.execute(),
		).rejects.toThrow(/price_checks_price_nonneg/);

		await expect(
			db
				.updateTable("items")
				.set({ target_price: 0 })
				.where("id", "=", item.id)
				.execute(),
		).rejects.toThrow(/items_target_price_positive/);
	});

	it("caps a comparison group at 4 items", async () => {
		const group = await db
			.insertInto("comparison_groups")
			.values({ name: "Headphones" })
			.returning("id")
			.executeTakeFirstOrThrow();

		const items = [];
		for (let i = 0; i < 5; i++) {
			items.push(
				await db
					.insertInto("items")
					.values({ url: `https://a.fi/${i}`, store_hostname: "a.fi" })
					.returning("id")
					.executeTakeFirstOrThrow(),
			);
		}

		for (let i = 0; i < 4; i++) {
			await db
				.insertInto("comparison_group_items")
				.values({ group_id: group.id, item_id: items[i].id, position: i })
				.execute();
		}

		// A 5th item has no legal position left.
		await expect(
			db
				.insertInto("comparison_group_items")
				.values({ group_id: group.id, item_id: items[4].id, position: 4 })
				.execute(),
		).rejects.toThrow(/cgi_position_range/);

		await expect(
			db
				.insertInto("comparison_group_items")
				.values({ group_id: group.id, item_id: items[4].id, position: 0 })
				.execute(),
		).rejects.toThrow(/cgi_group_position_key/);
	});

	it("cascades price_checks when an item is deleted", async () => {
		const item = await db
			.insertInto("items")
			.values({ url: "https://a.fi/1", store_hostname: "a.fi" })
			.returning("id")
			.executeTakeFirstOrThrow();

		await db
			.insertInto("price_checks")
			.values({ item_id: item.id, price: 1000 })
			.execute();

		await db.deleteFrom("items").where("id", "=", item.id).execute();

		const remaining = await db.selectFrom("price_checks").selectAll().execute();
		expect(remaining).toHaveLength(0);
	});
});
