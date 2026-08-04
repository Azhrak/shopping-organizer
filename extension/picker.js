/**
 * The price picker overlay, injected on demand into a product page.
 *
 * Injected via chrome.scripting.executeScript from the popup rather than
 * declared as a content_script: picking a price is a deliberate, rare action,
 * and running this on every page the user visits would be a far larger privacy
 * and performance footprint for no benefit.
 *
 * Flow: hover highlights the element under the cursor and previews the price
 * that would be captured; click confirms; Escape or right-click cancels. The
 * selector is derived and VALIDATED here, and the price is parsed here, using
 * the same code the server runs (shared.generated.js) so the two can never
 * disagree about what was picked.
 *
 * Resolves to:
 *   { ok: true,  selector, price, currency, text, url }
 *   { ok: false, reason }
 */

export async function runPicker() {
	const { deriveSelector, parsePriceString } = await import(
		chrome.runtime.getURL("shared.generated.js")
	);

	// Guard against double injection — executeScript will happily run this
	// again if the user clicks the popup button mid-pick.
	if (window.__hintavahtiPickerActive) {
		return { ok: false, reason: "A picker is already running on this page." };
	}
	window.__hintavahtiPickerActive = true;

	const highlight = document.createElement("div");
	Object.assign(highlight.style, {
		position: "fixed",
		pointerEvents: "none",
		zIndex: "2147483647",
		border: "2px solid #7c5cff",
		background: "rgba(124, 92, 255, 0.15)",
		borderRadius: "3px",
		transition: "all 60ms ease-out",
		display: "none",
	});

	const hud = document.createElement("div");
	Object.assign(hud.style, {
		position: "fixed",
		zIndex: "2147483647",
		left: "50%",
		top: "16px",
		transform: "translateX(-50%)",
		padding: "10px 16px",
		borderRadius: "8px",
		background: "#14121c",
		color: "#f4f2ff",
		font: "14px/1.4 system-ui, sans-serif",
		boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
		pointerEvents: "none",
		maxWidth: "90vw",
		textAlign: "center",
	});
	hud.textContent = "Click the price. Esc to cancel.";

	document.documentElement.append(highlight, hud);

	/**
	 * Read the price text an element carries.
	 *
	 * Machine-readable attributes win over rendered text. Real markup splits a
	 * price across nodes — Verkkokauppa emits
	 *
	 *   <data data-price="current" value="11.99">11<small>,99</small></data>
	 *
	 * so the euros and the cents live in different nodes. textContent covers the
	 * whole subtree and reads "11,99" correctly, but `value` is unambiguous and
	 * needs no separator guessing, so it is preferred where present.
	 */
	function textOf(element) {
		for (const attribute of ["content", "value", "data-price-value"]) {
			const raw = element.getAttribute(attribute);
			if (raw !== null && raw.trim() !== "" && parsePriceString(raw) !== null) {
				return raw;
			}
		}
		return (element.textContent ?? "").trim();
	}

	/**
	 * The element to actually capture for a given hover target.
	 *
	 * Clicking the <small> holding the cents would otherwise capture ",99". When
	 * the target's own text does not parse but an ancestor's does, walk up to
	 * that ancestor — that is the element the user means.
	 */
	function priceTargetFor(element) {
		if (parsePriceString(textOf(element)) !== null) {
			return element;
		}

		let ancestor = element.parentElement;

		// Three levels is enough to climb out of a split price without wandering
		// into a container holding several unrelated numbers.
		for (let depth = 0; ancestor && depth < 3; depth += 1) {
			if (parsePriceString(textOf(ancestor)) !== null) {
				return ancestor;
			}
			ancestor = ancestor.parentElement;
		}

		return element;
	}

	function currencyOf(text) {
		if (text.includes("€")) return "EUR";
		if (text.includes("$")) return "USD";
		if (text.includes("£")) return "GBP";
		return null;
	}

	return new Promise((resolve) => {
		let current = null;
		let settled = false;

		function teardown() {
			highlight.remove();
			hud.remove();
			document.removeEventListener("mousemove", onMove, true);
			document.removeEventListener("click", onClick, true);
			document.removeEventListener("keydown", onKey, true);
			document.removeEventListener("contextmenu", onContext, true);
			window.__hintavahtiPickerActive = false;
		}

		function finish(result) {
			// Every exit path routes through here, so the overlay and its listeners
			// can never be left attached to the page.
			if (settled) {
				return;
			}
			settled = true;
			teardown();
			resolve(result);
		}

		function onMove(event) {
			const element = document.elementFromPoint(event.clientX, event.clientY);

			if (!element || element === highlight || element === hud) {
				return;
			}

			// Highlight and capture what will actually be recorded, not the node
			// the cursor happens to be over — so the preview cannot disagree with
			// what gets stored.
			current = priceTargetFor(element);
			const box = current.getBoundingClientRect();

			highlight.style.display = "block";
			highlight.style.left = `${box.left}px`;
			highlight.style.top = `${box.top}px`;
			highlight.style.width = `${box.width}px`;
			highlight.style.height = `${box.height}px`;

			const price = parsePriceString(textOf(current));
			hud.textContent =
				price === null
					? "No price here — keep looking. Esc to cancel."
					: `Capture ${price}? Click to confirm. Esc to cancel.`;
		}

		function onClick(event) {
			event.preventDefault();
			event.stopPropagation();

			const element = current;
			if (!element) {
				return;
			}

			const text = textOf(element);
			const price = parsePriceString(text);

			if (price === null) {
				// Stay in pick mode rather than sending something unparseable — an
				// invented price is worse than no price.
				hud.textContent = "That is not a price. Pick another element.";
				return;
			}

			const selector = deriveSelector(document, element);

			if (selector === null) {
				finish({
					ok: false,
					reason:
						"Could not derive a stable selector for that element. Try the price text itself, or a nearby element.",
				});
				return;
			}

			finish({
				ok: true,
				selector,
				price,
				currency: currencyOf(text),
				text,
				url: location.href,
			});
		}

		function onKey(event) {
			if (event.key === "Escape") {
				event.preventDefault();
				finish({ ok: false, reason: "cancelled" });
			}
		}

		function onContext(event) {
			event.preventDefault();
			finish({ ok: false, reason: "cancelled" });
		}

		// Capture phase throughout: product pages routinely stopPropagation in
		// their own handlers, which would otherwise swallow the pick.
		document.addEventListener("mousemove", onMove, true);
		document.addEventListener("click", onClick, true);
		document.addEventListener("keydown", onKey, true);
		document.addEventListener("contextmenu", onContext, true);
	});
}
