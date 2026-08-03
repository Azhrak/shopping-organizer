import "@tanstack/react-start/server-only";

/**
 * Server-only composition root for the service layer.
 *
 * The services take their database handle and extractor as injected
 * dependencies so they stay framework-agnostic and testable. This module is
 * where the real implementations are bound, and it is the ONLY place that
 * happens outside of tests.
 *
 * The bare "server-only" import above marks this file as server-restricted:
 * Start's import protection fails the build if any client bundle reaches it,
 * which in turn keeps extractPrice (cheerio, outbound fetch) out of the
 * browser.
 */

import { db } from "~/lib/db";
import { extractPrice } from "~/lib/extraction/extractPrice.server";
import type { ServiceDeps } from "~/lib/services/items.service";

export const deps: ServiceDeps = {
	db,
	extractPrice,
};
