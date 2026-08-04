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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message?.type !== "ingest") {
		return false;
	}

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
});
