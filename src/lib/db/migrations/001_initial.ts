import { type Kysely, type SqlBool, sql } from "kysely";

/**
 * Initial schema for Hintavahti.
 *
 * Prices are stored as integer minor units (cents) throughout — never floats.
 * All timestamps are timestamptz (UTC).
 */
export async function up(db: Kysely<any>): Promise<void> {
	await sql`CREATE TYPE availability AS ENUM ('in_stock', 'out_of_stock', 'unknown')`.execute(
		db,
	);
	await sql`CREATE TYPE extract_method AS ENUM ('json-ld', 'microdata', 'meta', 'selector')`.execute(
		db,
	);

	await db.schema
		.createTable("items")
		.addColumn("id", "uuid", (col) =>
			col.primaryKey().defaultTo(sql`gen_random_uuid()`),
		)
		.addColumn("url", "text", (col) => col.notNull().unique())
		.addColumn("title", "text")
		.addColumn("image", "text")
		.addColumn("store_hostname", "text", (col) => col.notNull())
		.addColumn("currency", "text")
		.addColumn("folder", "text", (col) => col.notNull().defaultTo("inbox"))
		.addColumn("target_price", "integer")
		.addColumn("notes", "text")
		.addColumn("extract_method", sql`extract_method`)
		.addColumn("extract_failing", "boolean", (col) =>
			col.notNull().defaultTo(false),
		)
		.addColumn("consecutive_failures", "integer", (col) =>
			col.notNull().defaultTo(0),
		)
		// Scheduling state. next_check_at is denormalized rather than derived
		// from price_checks so "what is due" stays a single indexed range scan
		// instead of an aggregate over the whole history table.
		.addColumn("last_checked_at", "timestamptz")
		.addColumn("next_check_at", "timestamptz", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		// Drop-alert dedupe: only alert when a new price is strictly below the
		// price we last alerted at, so the same level never fires twice.
		.addColumn("last_alert_price", "integer")
		.addColumn("last_alerted_at", "timestamptz")
		.addColumn("created_at", "timestamptz", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.addColumn("archived_at", "timestamptz")
		.addCheckConstraint(
			"items_target_price_positive",
			sql`target_price IS NULL OR target_price > 0`,
		)
		.addCheckConstraint(
			"items_consecutive_failures_nonneg",
			sql`consecutive_failures >= 0`,
		)
		.execute();

	// Partial indexes: archived items are never listed or scheduled, so keeping
	// them out shrinks both indexes.
	await db.schema
		.createIndex("items_folder_idx")
		.on("items")
		.column("folder")
		.where(sql<SqlBool>`archived_at IS NULL`)
		.execute();

	await db.schema
		.createIndex("items_due_idx")
		.on("items")
		.column("next_check_at")
		.where(sql<SqlBool>`archived_at IS NULL`)
		.execute();

	// Used by the per-hostname rate limiter when staggering scheduled checks.
	await db.schema
		.createIndex("items_store_hostname_idx")
		.on("items")
		.column("store_hostname")
		.execute();

	// Append-only price history. A failed extraction produces NO row here —
	// it bumps items.consecutive_failures and stamps items.last_checked_at
	// instead. That keeps price NOT NULL so no stats query can silently
	// average over nulls.
	await db.schema
		.createTable("price_checks")
		.addColumn("id", "bigserial", (col) => col.primaryKey())
		.addColumn("item_id", "uuid", (col) =>
			col.notNull().references("items.id").onDelete("cascade"),
		)
		.addColumn("price", "integer", (col) => col.notNull())
		.addColumn("availability", sql`availability`, (col) =>
			col.notNull().defaultTo(sql`'unknown'::availability`),
		)
		.addColumn("checked_at", "timestamptz", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.addCheckConstraint("price_checks_price_nonneg", sql`price >= 0`)
		.execute();

	// Serves history listing, the trailing-90-day window, and "latest check" —
	// all are (item_id, most-recent-first) scans.
	await db.schema
		.createIndex("price_checks_item_checked_idx")
		.on("price_checks")
		.columns(["item_id", "checked_at desc"])
		.execute();

	await db.schema
		.createTable("comparison_groups")
		.addColumn("id", "uuid", (col) =>
			col.primaryKey().defaultTo(sql`gen_random_uuid()`),
		)
		.addColumn("name", "text", (col) => col.notNull())
		.addColumn("created_at", "timestamptz", (col) =>
			col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
		)
		.execute();

	await db.schema
		.createTable("comparison_group_items")
		.addColumn("group_id", "uuid", (col) =>
			col.notNull().references("comparison_groups.id").onDelete("cascade"),
		)
		.addColumn("item_id", "uuid", (col) =>
			col.notNull().references("items.id").onDelete("cascade"),
		)
		.addColumn("position", "smallint", (col) => col.notNull())
		.addPrimaryKeyConstraint("comparison_group_items_pkey", [
			"group_id",
			"item_id",
		])
		// Hard ceiling of 4 items per group: positions 0-3, unique per group
		// (see index below). The MINIMUM of 2 cannot be expressed as a table
		// constraint — a group is necessarily empty the instant it is created —
		// so it is enforced in the service layer instead.
		.addCheckConstraint("cgi_position_range", sql`position BETWEEN 0 AND 3`)
		.execute();

	await db.schema
		.createIndex("cgi_group_position_key")
		.on("comparison_group_items")
		.columns(["group_id", "position"])
		.unique()
		.execute();

	await db.schema
		.createIndex("cgi_item_idx")
		.on("comparison_group_items")
		.column("item_id")
		.execute();
}

export async function down(db: Kysely<any>): Promise<void> {
	await db.schema.dropTable("comparison_group_items").execute();
	await db.schema.dropTable("comparison_groups").execute();
	await db.schema.dropTable("price_checks").execute();
	await db.schema.dropTable("items").execute();
	await sql`DROP TYPE IF EXISTS extract_method`.execute(db);
	await sql`DROP TYPE IF EXISTS availability`.execute(db);
}
