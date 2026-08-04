import { configProblem, loadConfig } from "./config.js";

/**
 * One button: collect every open http(s) tab and hand it to the service
 * worker, which performs the request and survives this popup closing.
 *
 * No content scripts — the server fetches and parses each page itself, so the
 * extension never needs to touch page content.
 */

const grabButton = document.getElementById("grab");
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

async function init() {
	urls = await collectUrls();

	const config = await loadConfig();
	const problem = configProblem(config);

	if (problem) {
		summary.textContent = `${urls.length} product tab(s) found.`;
		show(`${problem} Open Settings to finish setup.`, "warn");
		return;
	}

	if (urls.length === 0) {
		summary.textContent = "No http(s) tabs are open.";
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

init();
