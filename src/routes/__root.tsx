import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Link,
	Outlet,
	Scripts,
} from "@tanstack/react-router";

import appStyles from "~/styles.css?url";

export interface RouterContext {
	queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: "Hintavahti" },
		],
		links: [{ rel: "stylesheet", href: appStyles }],
	}),
	component: RootComponent,
	notFoundComponent: () => (
		<div className="p-8">
			<h1 className="text-xl font-semibold">Not found</h1>
			<Link to="/" className="text-blue-600 underline">
				Back to catalog
			</Link>
		</div>
	),
});

function RootComponent() {
	return (
		<html lang="fi">
			<head>
				<HeadContent />
			</head>
			<body>
				<div className="mx-auto max-w-6xl p-6">
					<header className="mb-6 flex items-baseline gap-6 border-b border-slate-200 pb-4 dark:border-slate-800">
						<Link to="/" className="text-lg font-semibold">
							Hintavahti
						</Link>
						<nav className="flex gap-4 text-sm">
							<Link
								to="/"
								activeProps={{ className: "font-medium underline" }}
								activeOptions={{ exact: true }}
							>
								Catalog
							</Link>
							<Link
								to="/compare"
								activeProps={{ className: "font-medium underline" }}
							>
								Comparisons
							</Link>
						</nav>
					</header>
					<Outlet />
				</div>
				<Scripts />
			</body>
		</html>
	);
}
