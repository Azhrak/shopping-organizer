import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import viteTsConfigPaths from "vite-tsconfig-paths";

// Plugin order matters: tsconfig paths must resolve before Start's compiler
// runs, and viteReact must come last so it sees Start's output.
export default defineConfig(({ command }) => {
	// NODE_ENV is a build-mode signal, not application config, but Vite loads
	// .env before this config runs — so a NODE_ENV=development line there (which
	// is the sensible value for `vite dev`) leaks into `vite build` and selects
	// React's DEVELOPMENT JSX runtime. The built server then calls jsxDEV, which
	// does not exist in the production React build, and every page 500s.
	//
	// Nothing in this app reads NODE_ENV, so derive it from the command that is
	// actually running and let that be authoritative. This makes a bare
	// `pnpm build` correct without the NODE_ENV=production prefix.
	process.env.NODE_ENV = command === "build" ? "production" : "development";

	return {
		plugins: [
			viteTsConfigPaths({
				projects: ["./tsconfig.json"],
			}),
			tailwindcss(),
			tanstackStart(),
			nitro(),
			viteReact(),
		],
	};
});
