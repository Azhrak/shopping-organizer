/**
 * Shared settings access for the popup, options page and service worker.
 *
 * chrome.storage.sync rather than localStorage: extension pages each have
 * their own storage, and a service worker has none at all, so localStorage
 * would leave the three surfaces disagreeing about where to send data.
 */

export const DEFAULTS = {
	apiBaseUrl: "http://localhost:3000",
	secret: "",
};

export async function loadConfig() {
	const stored = await chrome.storage.sync.get(DEFAULTS);

	return {
		apiBaseUrl: String(stored.apiBaseUrl || "")
			.trim()
			.replace(/\/+$/, ""),
		secret: String(stored.secret || "").trim(),
	};
}

export async function saveConfig({ apiBaseUrl, secret }) {
	await chrome.storage.sync.set({
		apiBaseUrl: String(apiBaseUrl).trim().replace(/\/+$/, ""),
		secret: String(secret).trim(),
	});
}

/**
 * Validate settings before any request is attempted.
 *
 * Returns null when usable, otherwise a message for the user. Catching this
 * here means a missing secret surfaces as "open Options" rather than as a
 * bare 401 from the server.
 */
export function configProblem(config) {
	if (!config.apiBaseUrl) {
		return "No API address configured yet.";
	}

	let parsed;
	try {
		parsed = new URL(config.apiBaseUrl);
	} catch {
		return `"${config.apiBaseUrl}" is not a valid URL.`;
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return "The API address must start with http:// or https://.";
	}

	if (!config.secret) {
		return "No shared secret configured yet.";
	}

	return null;
}
