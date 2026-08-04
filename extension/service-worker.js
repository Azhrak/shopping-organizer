import { configProblem, loadConfig } from "./config.js";

/**
 * Performs the ingest request on behalf of the popup.
 *
 * The popup closes the moment focus moves, which aborts any fetch it started.
 * The worker outlives it, so the request is issued here and the result is
 * returned via sendMessage — a popup that closes mid-import no longer loses
 * the batch.
 *
 * Strictly event-driven: no setInterval, no setTimeout, no alarms. An MV3
 * worker is terminated when idle, so a long-running timer would simply never
 * fire. Everything here runs inside a message handler.
 */

const INGEST_PATH = "/api/ingest";
const SECRET_HEADER = "x-hintavahti-secret";

/** Give up rather than hang forever on an unreachable host. */
const REQUEST_TIMEOUT_MS = 120_000;

async function ingest(urls) {
	const config = await loadConfig();

	const problem = configProblem(config);
	if (problem) {
		return { ok: false, error: problem, needsConfig: true };
	}

	// Entries are either bare URL strings (the bulk grab) or objects carrying a
	// picked selector and price. The route accepts both.
	if (urls.length === 0) {
		return { ok: false, error: "No http(s) tabs are open." };
	}

	// AbortSignal.timeout is available in MV3 workers and avoids holding a
	// timer of our own.
	let response;
	try {
		response = await fetch(`${config.apiBaseUrl}${INGEST_PATH}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				[SECRET_HEADER]: config.secret,
			},
			body: JSON.stringify({ urls }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		// A wrong host, a stopped server and a CORS rejection all land here as
		// an opaque TypeError, so the message names the likely causes rather
		// than guessing at one.
		const detail =
			error?.name === "TimeoutError"
				? "the server did not respond in time"
				: "could not reach the server — check the API address, that it is running, and that EXTENSION_ORIGIN allows this extension";

		return { ok: false, error: `Import failed: ${detail}.` };
	}

	if (response.status === 401) {
		return {
			ok: false,
			error: "The server rejected the shared secret.",
			needsConfig: true,
		};
	}

	if (response.status === 503) {
		return {
			ok: false,
			error: "The server has no INGEST_SECRET configured.",
		};
	}

	if (!response.ok) {
		return {
			ok: false,
			error: `Server returned ${response.status}.`,
		};
	}

	let body;
	try {
		body = await response.json();
	} catch {
		return { ok: false, error: "The server returned a malformed response." };
	}

	return { ok: true, ...body };
}

/**
 * Inject the picker into a tab, then ingest whatever the user pointed at.
 *
 * Driven from here rather than the popup because clicking into the page moves
 * focus, which closes the popup — an awaited result there would be aborted
 * every time. The worker outlives that.
 *
 * The badge is the only feedback available once the popup is gone, so it
 * reports the outcome.
 */
async function pick(tabId) {
	if (typeof tabId !== "number") {
		return { ok: false, error: "No tab to pick from." };
	}

	const config = await loadConfig();
	const problem = configProblem(config);

	if (problem) {
		await badge("!", "#b3261e", problem);
		return { ok: false, error: problem, needsConfig: true };
	}

	let injected;
	try {
		[injected] = await chrome.scripting.executeScript({
			target: { tabId },
			// The picker is a module because it imports the shared selector and
			// price code; func-injection cannot carry an import.
			files: ["picker-entry.js"],
		});
	} catch (error) {
		const detail =
			error instanceof Error ? error.message : "could not inject the picker";
		await badge("!", "#b3261e", detail);
		return { ok: false, error: detail };
	}

	void injected;

	// picker-entry.js reports the pick back through a separate message rather
	// than a return value: executeScript resolves as soon as the module's top
	// level finishes, long before the user has clicked anything.
	return { ok: true, started: true };
}

async function badge(text, colour, title) {
	await chrome.action.setBadgeText({ text });
	await chrome.action.setBadgeBackgroundColor({ color: colour });

	if (title) {
		await chrome.action.setTitle({ title: `Hintavahti — ${title}` });
	}
}

/** Save a completed pick, which is an ingest with the captured fields attached. */
async function savePick(pick_) {
	const entry = {
		url: pick_.url,
		priceSelector: pick_.selector,
		observedPrice: pick_.price,
	};

	if (pick_.currency) {
		entry.observedCurrency = pick_.currency;
	}

	const response = await ingest([entry]);

	if (response.ok) {
		const saved = response.results?.[0];
		await badge(
			"✓",
			"#1b7f3b",
			saved?.created === false ? "selector updated" : "price saved",
		);
	} else {
		await badge("!", "#b3261e", response.error ?? "save failed");
	}

	return response;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message?.type === "ingest") {
		ingest(Array.isArray(message.urls) ? message.urls : [])
			.then(sendResponse)
			.catch((error) =>
				sendResponse({
					ok: false,
					error: error instanceof Error ? error.message : "Unknown error",
				}),
			);

		// Keeps the message channel open for the async reply above.
		return true;
	}

	if (message?.type === "pick") {
		chrome.action.setBadgeText({ text: "…" });
		pick(message.tabId)
			.then(sendResponse)
			.catch((error) =>
				sendResponse({
					ok: false,
					error: error instanceof Error ? error.message : "Unknown error",
				}),
			);
		return true;
	}

	if (message?.type === "picked") {
		if (!message.result?.ok) {
			const reason = message.result?.reason ?? "cancelled";
			badge(reason === "cancelled" ? "" : "!", "#b3261e", reason).then(() =>
				sendResponse({ ok: true }),
			);
			return true;
		}

		savePick(message.result)
			.then(sendResponse)
			.catch((error) =>
				sendResponse({
					ok: false,
					error: error instanceof Error ? error.message : "Unknown error",
				}),
			);
		return true;
	}

	return false;
});
