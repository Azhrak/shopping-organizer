import { describe, expect, it } from "vitest";

import {
	errorMessage,
	mapSettledWithConcurrency,
} from "~/lib/core/concurrency";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("mapSettledWithConcurrency", () => {
	it("returns an empty array for no inputs without invoking the worker", async () => {
		let calls = 0;
		const results = await mapSettledWithConcurrency([], 4, async () => {
			calls++;
			return 1;
		});

		expect(results).toEqual([]);
		expect(calls).toBe(0);
	});

	it("preserves input order even when workers finish out of order", async () => {
		const results = await mapSettledWithConcurrency(
			[30, 10, 20],
			3,
			async (ms) => {
				await new Promise((resolve) => setTimeout(resolve, ms));
				return ms;
			},
		);

		expect(results).toEqual([
			{ status: "fulfilled", value: 30 },
			{ status: "fulfilled", value: 10 },
			{ status: "fulfilled", value: 20 },
		]);
	});

	it("passes the input index to the worker", async () => {
		const seen: Array<[string, number]> = [];

		await mapSettledWithConcurrency(
			["a", "b", "c"],
			1,
			async (input, index) => {
				seen.push([input, index]);
				return index;
			},
		);

		expect(seen).toEqual([
			["a", 0],
			["b", 1],
			["c", 2],
		]);
	});

	it("never exceeds the concurrency limit", async () => {
		let inFlight = 0;
		let peak = 0;

		await mapSettledWithConcurrency(
			Array.from({ length: 20 }, (_, i) => i),
			4,
			async (value) => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 1));
				inFlight--;
				return value;
			},
		);

		expect(peak).toBeLessThanOrEqual(4);
		// Guard against a degenerate implementation that runs everything serially
		// and would trivially satisfy the assertion above.
		expect(peak).toBeGreaterThan(1);
	});

	it("actually runs work in parallel up to the limit", async () => {
		const gates = [deferred<number>(), deferred<number>(), deferred<number>()];
		let started = 0;

		const run = mapSettledWithConcurrency(gates, 3, async (gate) => {
			started++;
			return gate.promise;
		});

		// Let the workers reach their await points.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(started).toBe(3);

		for (const [index, gate] of gates.entries()) {
			gate.resolve(index);
		}

		expect(await run).toEqual([
			{ status: "fulfilled", value: 0 },
			{ status: "fulfilled", value: 1 },
			{ status: "fulfilled", value: 2 },
		]);
	});

	it("captures a rejection without abandoning the remaining inputs", async () => {
		const results = await mapSettledWithConcurrency(
			[1, 2, 3, 4],
			2,
			async (value) => {
				if (value === 2) {
					throw new Error("boom");
				}
				return value * 10;
			},
		);

		expect(results.map((r) => r.status)).toEqual([
			"fulfilled",
			"rejected",
			"fulfilled",
			"fulfilled",
		]);
		expect(results[1]).toMatchObject({
			status: "rejected",
			reason: expect.objectContaining({ message: "boom" }),
		});
		expect(results[3]).toEqual({ status: "fulfilled", value: 40 });
	});

	it("survives every input rejecting", async () => {
		const results = await mapSettledWithConcurrency([1, 2], 2, async () => {
			throw new Error("all bad");
		});

		expect(results.every((r) => r.status === "rejected")).toBe(true);
		expect(results).toHaveLength(2);
	});

	it("clamps a limit larger than the input to the input length", async () => {
		let peak = 0;
		let inFlight = 0;

		await mapSettledWithConcurrency([1, 2], 100, async (value) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 1));
			inFlight--;
			return value;
		});

		expect(peak).toBe(2);
	});

	it("treats a limit below one as serial rather than deadlocking", async () => {
		const results = await mapSettledWithConcurrency(
			[1, 2, 3],
			0,
			async (v) => v,
		);

		expect(results).toEqual([
			{ status: "fulfilled", value: 1 },
			{ status: "fulfilled", value: 2 },
			{ status: "fulfilled", value: 3 },
		]);
	});

	it("processes every input exactly once", async () => {
		const inputs = Array.from({ length: 50 }, (_, i) => i);
		const seen = new Set<number>();
		let calls = 0;

		await mapSettledWithConcurrency(inputs, 7, async (value) => {
			calls++;
			seen.add(value);
			return value;
		});

		expect(calls).toBe(50);
		expect(seen.size).toBe(50);
	});
});

describe("errorMessage", () => {
	it("uses the message of an Error", () => {
		expect(errorMessage(new Error("nope"))).toBe("nope");
	});

	it("passes a thrown string through", () => {
		expect(errorMessage("plain string")).toBe("plain string");
	});

	it("does not serialise a thrown object to {}", () => {
		expect(errorMessage({ weird: true })).toBe("Unknown error");
		expect(errorMessage(null)).toBe("Unknown error");
		expect(errorMessage(undefined)).toBe("Unknown error");
	});
});
