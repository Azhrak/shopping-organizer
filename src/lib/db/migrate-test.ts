import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { Kysely, PostgresDialect } from "kysely";
import { Migrator } from "kysely/migration";
import { Client, Pool } from "pg";
import { CustomFileMigrationProvider } from "./customFileMigrationProvider";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

config({ path: path.resolve(__dirname, "../../../.env") });

async function ensureTestDatabaseExists(testDatabaseUrl: string) {
	const url = new URL(testDatabaseUrl);
	const dbName = url.pathname.replace(/^\//, "");

	// Connect to the default "postgres" maintenance database to run CREATE DATABASE.
	const adminUrl = new URL(testDatabaseUrl);
	adminUrl.pathname = "/postgres";

	const client = new Client({ connectionString: adminUrl.toString() });
	await client.connect();

	try {
		const { rows } = await client.query(
			"SELECT 1 FROM pg_database WHERE datname = $1",
			[dbName],
		);

		if (rows.length === 0) {
			// Database names cannot be parameterized; dbName comes from our own
			// .env, not user input, so a validated identifier is safe here.
			if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(dbName)) {
				throw new Error(
					`Refusing to create database with unsafe name: ${dbName}`,
				);
			}
			await client.query(`CREATE DATABASE ${dbName}`);
			console.log(`Created test database "${dbName}"`);
		} else {
			console.log(`Test database "${dbName}" already exists`);
		}
	} finally {
		await client.end();
	}
}

async function migrateTestDatabase() {
	const testDatabaseUrl = process.env.TEST_DATABASE_URL;

	if (!testDatabaseUrl) {
		console.error("TEST_DATABASE_URL is not set (check .env)");
		process.exit(1);
	}

	await ensureTestDatabaseExists(testDatabaseUrl);

	const db = new Kysely<unknown>({
		dialect: new PostgresDialect({
			pool: new Pool({ connectionString: testDatabaseUrl }),
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
		console.error("Failed to migrate test database");
		console.error(error);
		process.exit(1);
	}

	console.log("Test database migrated successfully");

	await db.destroy();
}

migrateTestDatabase();
