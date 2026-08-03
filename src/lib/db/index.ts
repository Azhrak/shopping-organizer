import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { DB } from "./types";

/**
 * Get database connection pool configuration
 */
function getPoolConfig() {
	const databaseUrl = process.env.DATABASE_URL;

	if (!databaseUrl) {
		throw new Error("DATABASE_URL environment variable is not set");
	}

	return {
		connectionString: databaseUrl,
		max: 10,
		idleTimeoutMillis: 30000,
		connectionTimeoutMillis: 2000,
	};
}

/**
 * Create database instance with Kysely.
 *
 * Query logging is opt-in via DB_LOG_QUERIES=true. The scheduler checks many
 * items per run, so logging every statement is noise by default.
 */
function createDatabase() {
	const dialect = new PostgresDialect({
		pool: new Pool(getPoolConfig()),
	});

	const logQueries = process.env.DB_LOG_QUERIES === "true";

	return new Kysely<DB>({
		dialect,
		log(event) {
			if (event.level === "error") {
				console.error("Query failed:", event.query.sql, event.error);
			} else if (logQueries && event.level === "query") {
				console.log("Query:", event.query.sql);
				console.log("Params:", event.query.parameters);
			}
		},
	});
}

// Singleton database instance
export const db = createDatabase();

/**
 * Close database connections (useful for cleanup in tests and scripts)
 */
export async function closeDatabase() {
	await db.destroy();
}
