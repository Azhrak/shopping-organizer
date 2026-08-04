/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Produced by scripts/build-extension-shared.ts from:
 *   src/lib/extraction/deriveSelector.ts
 *   src/lib/extraction/parse.ts  (parsePriceString only)
 *
 * Regenerate with: pnpm build:extension
 * shared.generated.test.ts fails if this file is out of date, so the picker and
 * the server can never disagree about a selector or a parsed price.
 */

/**
 * Derive a durable CSS selector for an element the user pointed at.
 *
 * This is the hard half of the price picker. The UI is straightforward; making
 * a selector that still resolves next week is not. Two things break naive
 * approaches on real retail pages:
 *
 *   - **Hashed class names.** CSS modules and styled-components emit classes
 *     like `css-1x9f2a` or `sc-bdVaJa` that change on every deploy.
 *   - **Positional paths.** A `nth-child` chain from <body> breaks the first
 *     time the store inserts a promo banner above the product.
 *
 * So candidates are generated in order of expected durability and each one is
 * VALIDATED against the document before being accepted: it must match exactly
 * one element, and that element must be the one the user clicked. The first
 * candidate that validates wins.
 *
 * If nothing validates, this returns null rather than emitting a fragile
 * selector. That mirrors the extractor's contract — refusing is better than
 * returning something plausible that silently records wrong data later.
 *
 * Pure and DOM-library-agnostic: it takes the element and its root document
 * through a tiny structural interface, so the same code is exercised by the
 * Vitest suite (against a fixture DOM) and by the extension in a real page.
 */
/**
 * Attributes worth trusting, most durable first.
 *
 * Test hooks (`data-testid` and friends) come first deliberately: a store
 * cannot rename them without breaking its own test suite, which makes them the
 * most stable identifiers on a commercial page. `itemprop` is schema.org
 * microdata — equally deliberate and equally unlikely to churn.
 */
const STABLE_ATTRIBUTES = [
    "data-test-id",
    "data-testid",
    "data-test",
    "data-cy",
    "data-qa",
    "itemprop",
    "data-price",
    "data-product-price",
];
/**
 * Class names that look machine-generated and must never be used as anchors.
 *
 * Matches CSS-modules (`css-1x9f2a`), styled-components (`sc-bdVaJa`), short
 * tokens with long digit runs, and anything carrying a 6+ character hex run.
 */
const HASHED_CLASS_PATTERNS = [
    /^css-[a-z0-9]+$/i,
    /^sc-[a-z0-9]+$/i,
    /^jsx-\d+$/i,
    /^[a-z]{1,3}\d{3,}$/i,
    /[a-f0-9]{6,}/i,
    /^_[a-z0-9]{5,}$/i,
];
/** Ids that are clearly generated rather than authored. */
const GENERATED_ID_PATTERNS = [
    /\d{4,}/,
    /^[a-f0-9-]{16,}$/i,
    /^(radix|headless|mui|ember|react)-/i,
    /^:r[a-z0-9]+:$/i,
];
/** CSS.escape is not available outside a browser, so escape conservatively. */
function escapeCss(value) {
    return value.replace(/["\\]/g, "\\$&");
}
function isHashedClass(className) {
    return HASHED_CLASS_PATTERNS.some((pattern) => pattern.test(className));
}
function isGeneratedId(id) {
    return GENERATED_ID_PATTERNS.some((pattern) => pattern.test(id));
}
function tagOf(element) {
    return element.tagName.toLowerCase();
}
function classesOf(element) {
    const list = element.classList;
    if (list && list.length > 0) {
        return Array.from({ length: list.length }, (_, i) => list[i]);
    }
    // classList is absent on some minimal DOM implementations; fall back to the
    // raw attribute so fixtures and real elements behave identically.
    const raw = element.getAttribute("class");
    if (!raw) {
        return [];
    }
    return raw.split(/\s+/).filter((value) => value !== "");
}
function stableClassesOf(element) {
    return classesOf(element).filter((name) => !isHashedClass(name));
}
/**
 * Does `selector` resolve to exactly `target` and nothing else?
 *
 * Both halves matter. A selector matching several elements is ambiguous — the
 * server would silently read whichever came first, which may be a
 * strike-through original price rather than the current one.
 */
export function validates(root, selector, target) {
    let matches;
    try {
        matches = root.querySelectorAll(selector);
    }
    catch {
        // An invalid selector is a failed candidate, never a thrown error.
        return false;
    }
    return matches.length === 1 && matches[0] === target;
}
/** `[attr="value"]`, optionally tag-qualified, for each stable attribute. */
function attributeCandidates(element) {
    const candidates = [];
    for (const attribute of STABLE_ATTRIBUTES) {
        const value = element.getAttribute(attribute);
        if (value === null || value.trim() === "") {
            continue;
        }
        const escaped = escapeCss(value);
        candidates.push(`[${attribute}="${escaped}"]`);
        candidates.push(`${tagOf(element)}[${attribute}="${escaped}"]`);
    }
    return candidates;
}
function idCandidates(element) {
    const id = element.id ?? element.getAttribute("id");
    if (!id || id.trim() === "" || isGeneratedId(id)) {
        return [];
    }
    return [`#${escapeCss(id)}`];
}
function classCandidates(element) {
    const stable = stableClassesOf(element);
    if (stable.length === 0) {
        return [];
    }
    const tag = tagOf(element);
    const candidates = [];
    // Single classes first — the fewer classes a selector depends on, the fewer
    // ways a redesign can invalidate it.
    for (const name of stable) {
        candidates.push(`.${escapeCss(name)}`);
        candidates.push(`${tag}.${escapeCss(name)}`);
    }
    // Then the full stable set, which disambiguates when one class is shared by
    // several elements.
    if (stable.length > 1) {
        const all = stable.map((name) => `.${escapeCss(name)}`).join("");
        candidates.push(all);
        candidates.push(`${tag}${all}`);
    }
    return candidates;
}
/** The element's position among siblings sharing its tag, 1-based. */
function nthOfType(element) {
    const parent = element.parentElement;
    if (!parent?.children) {
        return null;
    }
    const tag = tagOf(element);
    let index = 0;
    for (let i = 0; i < parent.children.length; i += 1) {
        const child = parent.children[i];
        if (tagOf(child) === tag) {
            index += 1;
            if (child === element) {
                return index;
            }
        }
    }
    return null;
}
/**
 * A short structural path, anchored to the nearest ancestor that has a stable
 * identifier of its own.
 *
 * `nth-of-type` rather than `nth-child`: inserting a <div> banner among <span>
 * siblings shifts every nth-child index but leaves nth-of-type untouched.
 */
function structuralCandidates(root, element) {
    const candidates = [];
    const segments = [];
    let current = element;
    let depth = 0;
    // Six levels is enough to escape a product card without producing a path so
    // long that any layout change breaks it.
    while (current && depth < 6) {
        const tag = tagOf(current);
        const position = nthOfType(current);
        segments.unshift(position === null ? tag : `${tag}:nth-of-type(${position})`);
        const parent = current.parentElement;
        if (!parent) {
            break;
        }
        // If the parent has a stable anchor, prefer a path rooted there: it is
        // immune to anything that changes above that point in the tree.
        for (const anchor of [
            ...attributeCandidates(parent),
            ...idCandidates(parent),
            ...classCandidates(parent),
        ]) {
            if (validates(root, anchor, parent)) {
                candidates.push(`${anchor} > ${segments.join(" > ")}`);
            }
        }
        current = parent;
        depth += 1;
    }
    return candidates;
}
/**
 * Produce the most durable selector that uniquely identifies `element`, or
 * null when no candidate validates.
 */
export function deriveSelector(root, element) {
    const ordered = [
        ...attributeCandidates(element),
        ...idCandidates(element),
        ...classCandidates(element),
        ...structuralCandidates(root, element),
    ];
    for (const candidate of ordered) {
        if (validates(root, candidate, element)) {
            return candidate;
        }
    }
    return null;
}

/**
 * Parse a price string into a MAJOR-unit number, or null if it is ambiguous.
 *
 * The hard case is separators: "1.299,00" (European) and "1,299.00" (US) mean
 * the same amount, while "1.299" alone could be either 1299 or 1.299. Rules:
 *
 *   - If both separators appear, the LAST one is the decimal separator.
 *   - If one appears once with exactly 2 digits after it, it is a decimal.
 *   - If one appears with exactly 3 digits after it, it is a thousands group.
 *   - Anything else with a lone separator is ambiguous -> null.
 *
 * "1.299" therefore returns null rather than picking a reading, which is the
 * whole point: guessing here is a 1000x error.
 */
export function parsePriceString(raw) {
    if (raw === null || raw === undefined) {
        return null;
    }
    // JSON-LD often carries a real number already. Trust it as-is: there are no
    // separators to misread.
    if (typeof raw === "number") {
        return Number.isFinite(raw) && raw >= 0 ? raw : null;
    }
    // Strip currency symbols, letters, and whitespace (including the NBSP and
    // narrow-NBSP that Finnish formatting uses), keeping only digits and
    // separators.
    const cleaned = raw.replace(/[^\d.,-]/g, "").trim();
    if (cleaned === "" || cleaned === "-") {
        return null;
    }
    // A negative price is never valid for a product.
    if (cleaned.startsWith("-")) {
        return null;
    }
    const lastDot = cleaned.lastIndexOf(".");
    const lastComma = cleaned.lastIndexOf(",");
    let normalised;
    if (lastDot !== -1 && lastComma !== -1) {
        // Both present: the rightmost is the decimal separator, the other groups.
        const decimalSep = lastDot > lastComma ? "." : ",";
        const groupSep = decimalSep === "." ? "," : ".";
        normalised = cleaned.split(groupSep).join("").replace(decimalSep, ".");
    }
    else if (lastDot === -1 && lastComma === -1) {
        normalised = cleaned;
    }
    else {
        const sep = lastDot !== -1 ? "." : ",";
        const parts = cleaned.split(sep);
        // More than one separator of the same kind means grouping: 1.234.567
        if (parts.length > 2) {
            // Every group after the first must be exactly 3 digits, or this is
            // not a grouped number and we cannot read it.
            const groupsValid = parts.slice(1).every((part) => /^\d{3}$/.test(part));
            if (!groupsValid) {
                return null;
            }
            normalised = parts.join("");
        }
        else {
            const tail = parts[1] ?? "";
            if (/^\d{2}$/.test(tail)) {
                // 12,34 / 12.34 -> decimal
                normalised = `${parts[0]}.${tail}`;
            }
            else if (/^\d{3}$/.test(tail)) {
                // 1.299 / 1,299 -> ambiguous in principle, but a 3-digit tail is
                // overwhelmingly a thousands group and never a valid 3-decimal
                // price in EUR retail. Treat as grouping.
                normalised = `${parts[0]}${tail}`;
            }
            else if (/^\d{1}$/.test(tail)) {
                // 12,5 -> one decimal place
                normalised = `${parts[0]}.${tail}`;
            }
            else {
                return null;
            }
        }
    }
    if (!/^\d+(\.\d+)?$/.test(normalised)) {
        return null;
    }
    const value = Number(normalised);
    if (!Number.isFinite(value) || value <= 0) {
        return null;
    }
    return value;
}
