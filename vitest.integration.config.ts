import viteTsConfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		viteTsConfigPaths({
			projects: ["./tsconfig.json"],
		}),
	],
	test: {
		globals: true,
		environment: "node",
		setupFiles: ["./src/test/setupIntegration.ts"],
		passWithNoTests: false,
		include: ["**/*.integration.test.ts"],
		exclude: ["**/node_modules/**", "**/dist/**", "**/.output/**"],
		// Integration tests share one Postgres database and truncate between
		// tests — run serially so no two tests can observe each other's
		// in-flight data.
		fileParallelism: false,
	},
});
