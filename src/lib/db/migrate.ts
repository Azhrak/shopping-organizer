import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { Kysely, PostgresDialect } from "kysely";
import { Migrator } from "kysely/migration";
import { Pool } from "pg";
import { CustomFileMigrationProvider } from "./customFileMigrationProvider";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
config({ path: path.resolve(__dirname, "../../../.env") });

async function migrateToLatest() {
	const db = new Kysely<unknown>({
		dialect: new PostgresDialect({
			pool: new Pool({
				connectionString: process.env.DATABASE_URL,
			}),
		}),
	});

	const migrator = new Migrator({
		db,
		provider: new CustomFileMigrationProvider(
			path.join(__dirname, "migrations"),
		),
	});

	const { error, results } = await migrator.migrateToLatest();

	results?.forEach((it) => {
		if (it.status === "Success") {
			console.log(`Migration "${it.migrationName}" was executed successfully`);
		} else if (it.status === "Error") {
			console.error(`Failed to execute migration "${it.migrationName}"`);
		}
	});

	if (error) {
		console.error("Failed to migrate");
		console.error(error);
		process.exit(1);
	}

	console.log("All migrations executed successfully");

	await db.destroy();
}

migrateToLatest();
