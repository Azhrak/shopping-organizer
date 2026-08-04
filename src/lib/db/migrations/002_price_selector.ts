import { type Kysely, sql } from "kysely";

/**
 * User-pointed price selection.
 *
 * `price_selector` holds a CSS selector the user picked in their browser via
 * the extension. It is nullable and has no default: a null selector means
 * "generic cascade only", which is exactly the behaviour of every row that
 * existed before this migration, so nothing needs backfilling.
 *
 * `extract_method` deliberately gains no new enum member — a user-picked
 * selector reports as the existing 'selector' value. Whether a selector was
 * hardcoded in parse.ts or picked by the user is recoverable from
 * `price_selector IS NOT NULL`, so it does not need its own method.
 *
 * `price_selector_failing` is kept separate from `extract_failing` so the UI
 * can distinguish "your selector stopped matching" — fixable by re-picking —
 * from the generic "extraction failed". A stored selector that stops matching
 * falls through to the normal cascade rather than failing the item outright,
 * so the two flags genuinely differ.
 */
export async function up(db: Kysely<any>): Promise<void> {
	await db.schema
		.alterTable("items")
		.addColumn("price_selector", "text")
		.execute();

	await db.schema
		.alterTable("items")
		.addColumn("price_selector_failing", "boolean", (col) =>
			col.notNull().defaultTo(false),
		)
		.execute();

	// A selector is bounded to keep a pathological value from becoming a CPU
	// sink when cheerio runs it against every due item during a cron run.
	await db.schema
		.alterTable("items")
		.addCheckConstraint(
			"items_price_selector_length",
			sql`price_selector IS NULL OR (length(price_selector) > 0 AND length(price_selector) <= 500)`,
		)
		.execute();
}

export async function down(db: Kysely<any>): Promise<void> {
	await db.schema
		.alterTable("items")
		.dropConstraint("items_price_selector_length")
		.execute();

	await db.schema
		.alterTable("items")
		.dropColumn("price_selector_failing")
		.execute();

	await db.schema.alterTable("items").dropColumn("price_selector").execute();
}
