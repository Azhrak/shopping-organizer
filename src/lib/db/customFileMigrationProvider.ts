import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Migration, MigrationProvider } from "kysely/migration";

/**
 * Custom migration provider that works cross-platform (Windows, Linux, macOS)
 * Converts file paths to file:// URLs to avoid ESM loader issues with dynamic imports
 */
export class CustomFileMigrationProvider implements MigrationProvider {
	constructor(private migrationFolder: string) {}

	async getMigrations(): Promise<Record<string, Migration>> {
		const migrations: Record<string, Migration> = {};
		const files = await fs.readdir(this.migrationFolder);

		for (const fileName of files) {
			if (
				fileName.endsWith(".ts") ||
				(fileName.endsWith(".js") && !fileName.endsWith(".d.ts"))
			) {
				const migrationKey = fileName.substring(0, fileName.lastIndexOf("."));
				const filePath = path.join(this.migrationFolder, fileName);
				const fileUrl = pathToFileURL(filePath).href;
				const migration = await import(fileUrl);
				migrations[migrationKey] = migration;
			}
		}

		return migrations;
	}
}
