import "@tanstack/react-start/server-only";

import { timingSafeEqual } from "node:crypto";

/**
 * Shared-secret authentication for the EXTERNAL surface.
 *
 * The Chrome extension and the cron trigger cannot send same-origin
 * Origin/Referer headers, so Start's CSRF middleware would reject them — see
 * the filter in src/start.ts. They are server ROUTES instead, and this header
 * check is their only gate.
 *
 * Server-only: this module reads INGEST_SECRET and must never be reachable
 * from a client bundle.
 */

export const SECRET_HEADER = "x-hintavahti-secret";

/** Header the browser must be allowed to send on a cross-origin request. */
export const CORS_ALLOWED_HEADERS = `content-type, ${SECRET_HEADER}`;

export type AuthFailure = "not-configured" | "missing" | "invalid";

export type AuthResult =
	| { ok: true }
	| { ok: false; reason: AuthFailure; status: number };

function readSecret(): string | null {
	const secret = process.env.INGEST_SECRET;

	if (!secret || secret.length === 0) {
		return null;
	}

	// The shipped .env.example placeholder must never authenticate anything.
	if (secret === "change-me") {
		return null;
	}

	return secret;
}

/**
 * Constant-time string comparison.
 *
 * timingSafeEqual throws when the buffers differ in length, which would leak
 * secret length through the exception path, so length is folded into the
 * result instead of short-circuiting on it.
 */
function secretsMatch(provided: string, expected: string): boolean {
	const a = Buffer.from(provided, "utf8");
	const b = Buffer.from(expected, "utf8");

	if (a.length !== b.length) {
		// Still burn a comparison against a same-length buffer so the timing of
		// a wrong-length guess resembles a wrong-value guess.
		timingSafeEqual(b, b);
		return false;
	}

	return timingSafeEqual(a, b);
}

/**
 * Check the shared-secret header on an incoming external request.
 *
 * Returns 503 when the server has no secret configured — that is an operator
 * misconfiguration, not a caller error, and must not be reported as 401 (which
 * would invite the caller to retry with different credentials forever).
 */
export function authenticateExternal(request: Request): AuthResult {
	const expected = readSecret();

	if (expected === null) {
		return { ok: false, reason: "not-configured", status: 503 };
	}

	const provided = request.headers.get(SECRET_HEADER);

	if (provided === null || provided.length === 0) {
		return { ok: false, reason: "missing", status: 401 };
	}

	if (!secretsMatch(provided, expected)) {
		return { ok: false, reason: "invalid", status: 401 };
	}

	return { ok: true };
}

const AUTH_FAILURE_MESSAGES: Record<AuthFailure, string> = {
	"not-configured":
		"INGEST_SECRET is not configured on the server. External endpoints are disabled.",
	missing: `Missing ${SECRET_HEADER} header.`,
	invalid: "Invalid shared secret.",
};

export function authFailureMessage(reason: AuthFailure): string {
	return AUTH_FAILURE_MESSAGES[reason];
}

/**
 * Origins permitted to call the external routes from a browser.
 *
 * EXTENSION_ORIGIN is a chrome-extension:// origin, which is opaque to the
 * usual same-site rules, so it must be named explicitly. Multiple origins may
 * be given comma-separated (e.g. an unpacked dev extension and a packed one).
 */
function allowedOrigins(): Array<string> {
	const configured = process.env.EXTENSION_ORIGIN;

	if (!configured) {
		return [];
	}

	return configured
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value.length > 0 && !value.includes("replace-with"));
}

/**
 * CORS headers for a request, echoing the origin only when it is allow-listed.
 *
 * Never returns a wildcard: these endpoints are secret-gated, and a wildcard
 * would let any page on the internet probe them.
 */
export function corsHeaders(request: Request): Record<string, string> {
	const origin = request.headers.get("Origin");

	if (!origin || !allowedOrigins().includes(origin)) {
		return {};
	}

	return {
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Methods": "POST, OPTIONS",
		"Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS,
		"Access-Control-Max-Age": "86400",
		Vary: "Origin",
	};
}

/** JSON response carrying the CORS headers appropriate for this request. */
export function jsonResponse(
	request: Request,
	body: unknown,
	status = 200,
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			// External endpoints are never cacheable — an intermediary caching an
			// ingest result would silently swallow later imports.
			"Cache-Control": "no-store",
			...corsHeaders(request),
		},
	});
}

/** Preflight response. Mirrors what corsHeaders would allow for the real call. */
export function preflightResponse(request: Request): Response {
	const headers = corsHeaders(request);

	// An origin that is not allow-listed gets 403 rather than a bare 204, so a
	// misconfigured EXTENSION_ORIGIN surfaces as a clear failure in devtools.
	if (Object.keys(headers).length === 0) {
		return new Response(null, { status: 403 });
	}

	return new Response(null, { status: 204, headers });
}
