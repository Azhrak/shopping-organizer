/**
 * Bounded-concurrency mapping.
 *
 * Framework-agnostic and dependency-free. Both the bulk ingest route and the
 * scheduled check run use this, so there is one implementation of "do these N
 * things, at most K at a time, and never let one failure kill the batch".
 */

export type Settled<T> =
	| { status: "fulfilled"; value: T }
	| { status: "rejected"; reason: unknown };

/**
 * Run `worker` over every input with at most `limit` in flight.
 *
 * Results are returned in INPUT order, not completion order — callers pair
 * them back up with their input by index.
 *
 * Individual rejections are captured rather than propagated: one unreachable
 * store must not abandon the other URLs in the batch. Callers inspect the
 * per-entry status.
 */
export async function mapSettledWithConcurrency<TIn, TOut>(
	inputs: ReadonlyArray<TIn>,
	limit: number,
	worker: (input: TIn, index: number) => Promise<TOut>,
): Promise<Array<Settled<TOut>>> {
	if (inputs.length === 0) {
		return [];
	}

	const effectiveLimit = Math.max(
		1,
		Math.min(Math.floor(limit), inputs.length),
	);
	const results = new Array<Settled<TOut>>(inputs.length);

	// Shared cursor: workers pull the next index rather than being handed a
	// fixed slice, so a slow store cannot leave other workers idle.
	let cursor = 0;

	async function drain(): Promise<void> {
		while (true) {
			const index = cursor++;
			if (index >= inputs.length) {
				return;
			}

			try {
				results[index] = {
					status: "fulfilled",
					value: await worker(inputs[index] as TIn, index),
				};
			} catch (reason) {
				results[index] = { status: "rejected", reason };
			}
		}
	}

	await Promise.all(Array.from({ length: effectiveLimit }, () => drain()));

	return results;
}

/**
 * Extract a human-readable message from an unknown thrown value.
 *
 * Error responses cross a process boundary to the extension and the cron
 * caller, so a thrown non-Error must not serialise to "{}".
 */
export function errorMessage(reason: unknown): string {
	if (reason instanceof Error) {
		return reason.message;
	}
	if (typeof reason === "string") {
		return reason;
	}
	return "Unknown error";
}
