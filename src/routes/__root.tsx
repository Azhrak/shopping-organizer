import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Link,
	Outlet,
	Scripts,
} from "@tanstack/react-router";

import { themeInitScript } from "~/components/AppShell";
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
			<h1 className="text-xl font-medium text-text">Not found</h1>
			<Link to="/" className="text-accent hover:text-accent-hi">
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
				{/*
				 * Runs before first paint so a stored light theme does not flash
				 * dark. Must stay in <head> and stay synchronous.
				 */}
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: static, non-user-controlled theme bootstrap */}
				<script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
			</head>
			<body>
				<Outlet />
				<Scripts />
			</body>
		</html>
	);
}
