import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import type { SmartFilterCounts } from "~/lib/services/queries.service";

/**
 * Application chrome: header, folder sidebar, theme toggle.
 *
 * Ported from design/Hintavahti.dc.html. The design's mock user avatar is
 * omitted — this is a single-user self-hosted app with no accounts, so an
 * avatar would imply an identity the app does not have.
 */

/**
 * Applies the stored theme before first paint.
 *
 * Without this the server renders dark (the default), and a user who chose
 * light would see a dark flash on every navigation. Runs synchronously in
 * <head> and reads the same key the toggle writes.
 */
export const THEME_STORAGE_KEY = "hintavahti-theme";

export const themeInitScript = `
(function(){
  try {
    var stored = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    var theme = stored || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    if (theme === 'light') document.documentElement.setAttribute('data-theme','light');
  } catch (e) {}
})();
`.trim();

export function ThemeToggle() {
	// Reads and writes the DOM directly rather than through React state: the
	// value is owned by the pre-paint script above, and mirroring it into state
	// would let the two disagree on the first render.
	function toggle() {
		const root = document.documentElement;
		const next = root.getAttribute("data-theme") === "light" ? "dark" : "light";

		if (next === "light") {
			root.setAttribute("data-theme", "light");
		} else {
			root.removeAttribute("data-theme");
		}

		try {
			localStorage.setItem(THEME_STORAGE_KEY, next);
		} catch {
			// A blocked localStorage costs persistence, not the toggle itself.
		}
	}

	return (
		<button
			type="button"
			onClick={toggle}
			title="Toggle light / dark"
			aria-label="Toggle light and dark theme"
			className="grid size-8 place-items-center rounded-lg border border-divider text-muted hover:border-accent hover:text-accent"
		>
			<i className="ph ph-circle-half-tilt" aria-hidden="true" />
		</button>
	);
}

const navLinkClass =
	"rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-hair hover:text-text";
const navActiveClass = "text-accent";

export function AppHeader() {
	return (
		<header className="sticky top-0 z-20 flex items-center gap-6 bg-surface-2 px-4 py-3 shadow-[0_1px_0_var(--color-hair)]">
			<Link to="/" className="mr-auto flex items-center gap-2">
				<span className="grid size-[22px] place-items-center rounded-md border border-accent text-[12px] text-accent">
					<i className="ph ph-eye" aria-hidden="true" />
				</span>
				<span className="text-[17px] font-medium tracking-[-0.02em] text-text">
					Hintavahti
				</span>
				<span className="ml-1.5 text-[11px] uppercase tracking-[0.06em] text-faint">
					price watch
				</span>
			</Link>

			<nav className="flex items-center gap-1">
				<Link
					to="/"
					className={navLinkClass}
					activeProps={{ className: `${navLinkClass} ${navActiveClass}` }}
					activeOptions={{ exact: true }}
				>
					Catalog
				</Link>
				<Link
					to="/compare"
					className={navLinkClass}
					activeProps={{ className: `${navLinkClass} ${navActiveClass}` }}
				>
					Comparison
				</Link>
			</nav>

			<ThemeToggle />
		</header>
	);
}

export interface SidebarProps {
	folders: Array<{ folder: string; count: number }>;
	counts: SmartFilterCounts;
	activeFolder?: string | null;
	activeSmartFilter?: string | null;
	/** Footer status line; omitted when nothing has been checked yet. */
	lastCheckedAt?: Date | null;
	totalItems: number;
	storeCount: number;
}

const sideButtonBase =
	"flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm w-full text-left";
const sideButtonIdle = `${sideButtonBase} text-muted hover:bg-hair hover:text-text`;
const sideButtonActive = `${sideButtonBase} bg-accent-tint shadow-[inset_0_0_0_1px_var(--color-accent-deep)] text-text`;

function relativeTime(value: Date): string {
	const minutes = Math.round((Date.now() - value.getTime()) / 60000);

	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;

	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h ago`;

	return `${Math.round(hours / 24)} d ago`;
}

export function Sidebar({
	folders,
	counts,
	activeFolder,
	activeSmartFilter,
	lastCheckedAt,
	totalItems,
	storeCount,
}: SidebarProps) {
	const allActive = !activeFolder && !activeSmartFilter;

	return (
		<aside
			data-side="folders"
			className="sticky top-[55px] hidden w-[210px] flex-none self-start px-3 py-4 md:block"
		>
			<div className="px-2 pb-2 text-[10px] uppercase tracking-[0.1em] text-faint">
				Folders
			</div>
			<div className="flex flex-col gap-px">
				<Link
					to="/"
					search={{}}
					className={allActive ? sideButtonActive : sideButtonIdle}
				>
					<i className="ph ph-squares-four text-accent" aria-hidden="true" />
					<span className="flex-1">All saved</span>
					<span className="text-xs text-muted">{totalItems}</span>
				</Link>

				{folders.map(({ folder, count }) => (
					<Link
						key={folder}
						to="/"
						search={{ folder }}
						className={
							activeFolder === folder ? sideButtonActive : sideButtonIdle
						}
					>
						<i className="ph ph-folder-simple" aria-hidden="true" />
						<span className="flex-1 truncate">{folder}</span>
						<span className="text-xs">{count}</span>
					</Link>
				))}
			</div>

			<div className="my-4 h-px bg-[linear-gradient(to_right,transparent,var(--color-hair)_24px,var(--color-hair)_calc(100%-24px),transparent)]" />

			<div className="px-2 pb-2 text-[10px] uppercase tracking-[0.1em] text-faint">
				Watching
			</div>
			<div className="flex flex-col gap-px">
				<Link
					to="/"
					search={{ view: "dropped" as const }}
					className={
						activeSmartFilter === "dropped" ? sideButtonActive : sideButtonIdle
					}
				>
					<i className="ph ph-trend-down text-good" aria-hidden="true" />
					<span className="flex-1">Dropped this week</span>
					<span className="text-xs">{counts.dropped}</span>
				</Link>
				<Link
					to="/"
					search={{ view: "at_target" as const }}
					className={
						activeSmartFilter === "at_target"
							? sideButtonActive
							: sideButtonIdle
					}
				>
					<i className="ph ph-target" aria-hidden="true" />
					<span className="flex-1">At target price</span>
					<span className="text-xs">{counts.atTarget}</span>
				</Link>
				<Link to="/" search={{ archived: true }} className={sideButtonIdle}>
					<i className="ph ph-archive" aria-hidden="true" />
					<span className="flex-1">Archive</span>
					<span className="text-xs">{counts.archived}</span>
				</Link>
			</div>

			<div className="mt-6 rounded-lg bg-surface p-3 shadow-card">
				<div className="text-xs leading-[1.45] text-muted">
					{lastCheckedAt ? (
						<>
							Last check{" "}
							<span className="text-text">{relativeTime(lastCheckedAt)}</span>
							<br />
						</>
					) : null}
					Watching {totalItems} {totalItems === 1 ? "item" : "items"} in{" "}
					{storeCount} {storeCount === 1 ? "store" : "stores"}.
				</div>
			</div>
		</aside>
	);
}

export function AppLayout({
	sidebar,
	children,
}: {
	sidebar?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="flex min-h-screen flex-col bg-bg text-text">
			<AppHeader />
			<div className="flex flex-1 items-start">
				{sidebar}
				<main className="min-w-0 flex-1 px-4 pb-12 pt-4 md:px-6">
					{children}
				</main>
			</div>
		</div>
	);
}
