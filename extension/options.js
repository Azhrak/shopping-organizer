import { configProblem, loadConfig, saveConfig } from "./config.js";

const apiBaseUrl = document.getElementById("apiBaseUrl");
const secret = document.getElementById("secret");
const origin = document.getElementById("origin");
const status = document.getElementById("status");

function show(message, tone) {
	status.hidden = false;
	status.textContent = message;
	status.className = tone ? `result ${tone}` : "result";
}

// The value the server needs in EXTENSION_ORIGIN. Showing it here beats making
// the user derive it from the extension id by hand.
origin.value = `chrome-extension://${chrome.runtime.id}`;

const stored = await loadConfig();
apiBaseUrl.value = stored.apiBaseUrl;
secret.value = stored.secret;

document.getElementById("save").addEventListener("click", async () => {
	const next = { apiBaseUrl: apiBaseUrl.value, secret: secret.value };
	const problem = configProblem({
		apiBaseUrl: next.apiBaseUrl.trim().replace(/\/+$/, ""),
		secret: next.secret.trim(),
	});

	if (problem) {
		show(problem, "warn");
		return;
	}

	await saveConfig(next);
	show("Saved.", "ok");
});

/**
 * Check the address, CORS allow-list and secret without importing anything.
 *
 * The preflight tells us whether this extension's origin is allow-listed; a
 * POST with an empty url list then exercises the secret — the server
 * authenticates before it validates the body, so a bad secret answers 401 and
 * a good one answers 400 for the empty array. Nothing is ever saved.
 */
document.getElementById("test").addEventListener("click", async () => {
	const config = {
		apiBaseUrl: apiBaseUrl.value.trim().replace(/\/+$/, ""),
		secret: secret.value.trim(),
	};

	const problem = configProblem(config);
	if (problem) {
		show(problem, "warn");
		return;
	}

	show("Testing…");

	const endpoint = `${config.apiBaseUrl}/api/ingest`;

	let preflight;
	try {
		preflight = await fetch(endpoint, {
			method: "OPTIONS",
			signal: AbortSignal.timeout(15_000),
		});
	} catch {
		show(
			"Could not reach the server. Check the address and that it is running.",
			"warn",
		);
		return;
	}

	if (preflight.status === 403) {
		show(
			`The server does not allow this extension. Add ${origin.value} to EXTENSION_ORIGIN and restart it.`,
			"warn",
		);
		return;
	}

	let response;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-hintavahti-secret": config.secret,
			},
			body: JSON.stringify({ urls: [] }),
			signal: AbortSignal.timeout(15_000),
		});
	} catch {
		show("Could not reach the server.", "warn");
		return;
	}

	if (response.status === 401) {
		show("The server rejected the shared secret.", "warn");
		return;
	}

	if (response.status === 503) {
		show("The server has no INGEST_SECRET configured.", "warn");
		return;
	}

	// 400 is the expected answer to an empty url list, and proves the request
	// got past authentication.
	if (response.status === 400 || response.ok) {
		show("Connected. Address, origin and secret all check out.", "ok");
		return;
	}

	show(`Unexpected response: ${response.status}.`, "warn");
});
