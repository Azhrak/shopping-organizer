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
		passWithNoTests: false,
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"**/.output/**",
			"src/routes/**",
			"**/*.integration.test.ts",
		],
		env: {
			// Unit tests must never hit a real database. This is a placeholder
			// connection string so modules that eagerly construct a pg Pool at
			// import time (src/lib/db/index.ts) don't throw on import; pg's Pool
			// doesn't connect until a query runs, and no test in this suite runs one.
			DATABASE_URL: "postgresql://test:test@localhost:5434/test",
		},
	},
});
