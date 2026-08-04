/**
 * Injection entry point for the price picker.
 *
 * chrome.scripting.executeScript with `files` runs this in the page's isolated
 * world. It cannot be picker.js directly, because an injected file is not a
 * module and so cannot use a static import — this bootstraps into one via a
 * dynamic import of the extension URL instead.
 *
 * The result is reported with a "picked" message rather than a return value:
 * executeScript resolves as soon as this script's top level finishes, which is
 * long before the user has clicked anything.
 */

(async () => {
	try {
		const { runPicker } = await import(chrome.runtime.getURL("picker.js"));
		const result = await runPicker();

		await chrome.runtime.sendMessage({ type: "picked", result });
	} catch (error) {
		await chrome.runtime.sendMessage({
			type: "picked",
			result: {
				ok: false,
				reason:
					error instanceof Error ? error.message : "the picker failed to run",
			},
		});
	}
})();
