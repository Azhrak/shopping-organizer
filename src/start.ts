import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

// Start installs a default CSRF middleware ONLY when src/start.ts is absent —
// see start-server-core/createStartHandler.js:
//   requestMiddleware: hasStartInstance ? startOptions.requestMiddleware : [defaultCsrfMiddleware]
// Defining this file replaces that default entirely, so it must be re-added
// here or server functions ship unprotected. The missing-middleware warning is
// dev-only, so a production build would fail silently.
//
// The filter is what exempts the external surface: /api/ingest and
// /api/cron/check are server ROUTES (handlerType !== "serverFn"), because the
// Chrome extension and cron trigger cannot send same-origin Origin/Referer
// headers. Those two routes authenticate with a shared secret header instead.
const csrfMiddleware = createCsrfMiddleware({
	filter: (ctx) => ctx.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
	requestMiddleware: [csrfMiddleware],
}));
