import { sql } from "kysely";
import { db } from "~/lib/db";

/**
 * Truncate every user table in the test database and restart identity
 * sequences, giving each test a clean slate without re-running migrations.
 * Table list is discovered from information_schema (not hardcoded) so this
 * never goes stale as migrations add tables. kysely_migration/
 * kysely_migration_lock are excluded — truncating them would wipe migration
 * history and force a re-migrate.
 */
export async function resetTestDatabase(): Promise<void> {
	const { rows } = await sql<{ tablename: string }>`
		SELECT tablename FROM pg_tables
		WHERE schemaname = 'public'
		AND tablename NOT IN ('kysely_migration', 'kysely_migration_lock')
	`.execute(db);

	if (rows.length === 0) {
		return;
	}

	const tableList = rows.map((r) => `"${r.tablename}"`).join(", ");
	await sql`TRUNCATE TABLE ${sql.raw(tableList)} RESTART IDENTITY CASCADE`.execute(
		db,
	);
}
