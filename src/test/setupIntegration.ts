import { config } from "dotenv";

// Load .env for TEST_DATABASE_URL, then point the db singleton at the test
// database. This file is loaded via vitest's `setupFiles`, which runs before
// any test file (and therefore before any test file's imports) — critical
// because src/lib/db/index.ts reads process.env.DATABASE_URL at module
// import time to construct its connection pool singleton.
config();

if (!process.env.TEST_DATABASE_URL) {
	throw new Error(
		"TEST_DATABASE_URL is not set. Copy .env.example's TEST_DATABASE_URL " +
			"line into .env, then run `pnpm db:migrate:test` before running " +
			"integration tests.",
	);
}

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
