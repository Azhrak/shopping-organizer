import { configProblem, loadConfig } from "./config.js";

/**
 * Two actions:
 *
 *   "Grab open tabs" — collect every open http(s) tab and hand it to the
 *   service worker, which performs the request and survives this popup closing.
 *
 *   "Point at the price" — inject the picker into the active tab so the user
 *   can click the price directly. This is how a store the server cannot read
 *   (bot-blocked, or JS-rendered) gets a real price: the user's own browser
 *   already rendered the page.
 *
 * The picker is injected on demand rather than declared as a content script,
 * so nothing runs on pages the user is merely visiting.
 */

const grabButton = document.getElementById("grab");
const pickButton = document.getElementById("pick");
const summary = document.getElementById("summary");
const result = document.getElementById("result");
const failures = document.getElementById("failures");

document.getElementById("options").addEventListener("click", () => {
	chrome.runtime.openOptionsPage();
});

/**
 * Every open http(s) tab, de-duplicated.
 *
 * chrome.tabs.query({}) spans all windows. chrome://, about:, file: and
 * extension pages are dropped here rather than sent for the server to reject.
 */
async function collectUrls() {
	const tabs = await chrome.tabs.query({});
	const urls = new Set();

	for (const tab of tabs) {
		if (!tab.url) continue;

		try {
			const { protocol } = new URL(tab.url);
			if (protocol === "http:" || protocol === "https:") {
				urls.add(tab.url);
			}
		} catch {
			// A tab with an unparseable URL is simply not a candidate.
		}
	}

	return [...urls];
}

function show(message, tone) {
	result.hidden = false;
	result.textContent = message;
	result.className = tone ? `result ${tone}` : "result";
}

function showFailures(entries) {
	const failed = entries.filter((entry) => !entry.ok);

	if (failed.length === 0) {
		failures.hidden = true;
		return;
	}

	failures.hidden = false;
	failures.replaceChildren(
		...failed.slice(0, 20).map((entry) => {
			const li = document.createElement("li");
			li.textContent = `${entry.url} — ${entry.error ?? "failed"}`;
			return li;
		}),
	);
}

let urls = [];

/** The active tab, when it is a page the picker can actually be injected into. */
async function pickableTab() {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

	if (!tab?.url || tab.id === undefined) {
		return null;
	}

	try {
		const { protocol } = new URL(tab.url);
		// chrome://, about:, file: and the Web Store all refuse injection. Better
		// to disable the button than to fail on click.
		if (protocol !== "http:" && protocol !== "https:") {
			return null;
		}
		if (tab.url.startsWith("https://chromewebstore.google.com/")) {
			return null;
		}
	} catch {
		return null;
	}

	return tab;
}

async function init() {
	urls = await collectUrls();

	const config = await loadConfig();
	const problem = configProblem(config);

	if (problem) {
		summary.textContent = `${urls.length} product tab(s) found.`;
		show(`${problem} Open Settings to finish setup.`, "warn");
		return;
	}

	// The picker only needs the active tab, so it stays available even when the
	// bulk grab has nothing to do.
	const tab = await pickableTab();
	pickButton.disabled = tab === null;

	if (urls.length === 0) {
		summary.textContent =
			tab === null
				? "No http(s) tabs are open."
				: "No tabs to grab — but you can point at a price here.";
		return;
	}

	summary.textContent = `${urls.length} open tab(s) ready to save.`;
	grabButton.disabled = false;
}

grabButton.addEventListener("click", async () => {
	grabButton.disabled = true;
	grabButton.textContent = "Saving…";
	failures.hidden = true;
	show("Contacting the server…");

	const response = await chrome.runtime.sendMessage({ type: "ingest", urls });

	grabButton.textContent = "Grab open tabs";

	if (!response?.ok) {
		show(response?.error ?? "Import failed.", "warn");
		grabButton.disabled = false;

		if (response?.needsConfig) {
			chrome.runtime.openOptionsPage();
		}
		return;
	}

	const parts = [`${response.saved} saved`];
	if (response.duplicates > 0) {
		parts.push(`${response.duplicates} already tracked`);
	}
	if (response.failed > 0) {
		parts.push(`${response.failed} failed`);
	}

	show(parts.join(" · "), response.failed > 0 ? "warn" : "ok");
	showFailures(response.results ?? []);
	grabButton.disabled = false;
});

pickButton.addEventListener("click", async () => {
	const tab = await pickableTab();

	if (!tab) {
		show("This page cannot be picked from.", "warn");
		return;
	}

	// Hand the whole flow to the worker and close immediately. Clicking into the
	// page to pick moves focus, which closes this popup anyway — awaiting the
	// result here would abort it every single time.
	chrome.runtime.sendMessage({ type: "pick", tabId: tab.id });
	window.close();
});

init();
