import { describe, expect, it, vi } from "vitest";
import {
	filterAsync,
	paginate,
	type PageFetcher,
} from "../lib/paginate.js";

/** Collect all items from an async iterable into an array. */
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const result: T[] = [];
	for await (const item of iterable) {
		result.push(item);
	}
	return result;
}

describe("paginate", () => {
	it("should yield all items across multiple pages", async () => {
		const fetcher: PageFetcher<{ name: string }, {}> = vi
			.fn()
			.mockResolvedValueOnce({
				items: [{ name: "a" }, { name: "b" }],
				hasMore: true,
			})
			.mockResolvedValueOnce({
				items: [{ name: "c" }, { name: "d" }],
				hasMore: false,
			});

		const result = await collect(
			paginate(fetcher, {}, (item) => item.name),
		);

		expect(result).toEqual([
			{ name: "a" },
			{ name: "b" },
			{ name: "c" },
			{ name: "d" },
		]);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("should handle a single page with hasMore=false", async () => {
		const fetcher: PageFetcher<{ name: string }, {}> = vi
			.fn()
			.mockResolvedValueOnce({
				items: [{ name: "only" }],
				hasMore: false,
			});

		const result = await collect(
			paginate(fetcher, {}, (item) => item.name),
		);

		expect(result).toEqual([{ name: "only" }]);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("should handle an empty first page", async () => {
		const fetcher: PageFetcher<{ name: string }, {}> = vi
			.fn()
			.mockResolvedValueOnce({
				items: [],
				hasMore: false,
			});

		const result = await collect(
			paginate(fetcher, {}, (item) => item.name),
		);

		expect(result).toEqual([]);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("should pass the cursor from the last item to the next page fetch", async () => {
		const fetcher: PageFetcher<{ name: string }, {}> = vi
			.fn()
			.mockResolvedValueOnce({
				items: [{ name: "first" }, { name: "second" }],
				hasMore: true,
			})
			.mockResolvedValueOnce({
				items: [{ name: "third" }],
				hasMore: false,
			});

		await collect(paginate(fetcher, {}, (item) => item.name));

		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(fetcher).toHaveBeenNthCalledWith(1, { startAfter: undefined });
		expect(fetcher).toHaveBeenNthCalledWith(2, { startAfter: "second" });
	});

	it("should stop when items array is empty even if hasMore is true (safety guard)", async () => {
		const fetcher: PageFetcher<{ name: string }, {}> = vi
			.fn()
			.mockResolvedValueOnce({
				items: [],
				hasMore: true,
			});

		const result = await collect(
			paginate(fetcher, {}, (item) => item.name),
		);

		expect(result).toEqual([]);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
});

describe("filterAsync", () => {
	it("should filter items based on the predicate", async () => {
		async function* source() {
			yield 1;
			yield 2;
			yield 3;
			yield 4;
			yield 5;
		}

		const result = await collect(
			filterAsync(source(), (n) => n % 2 === 0),
		);

		expect(result).toEqual([2, 4]);
	});

	it("should preserve order of items", async () => {
		async function* source() {
			yield "c";
			yield "a";
			yield "b";
		}

		const result = await collect(
			filterAsync(source(), () => true),
		);

		expect(result).toEqual(["c", "a", "b"]);
	});

	it("should handle empty async iterable", async () => {
		async function* source(): AsyncGenerator<number> {
			// yields nothing
		}

		const result = await collect(
			filterAsync(source(), () => true),
		);

		expect(result).toEqual([]);
	});

	it("should yield nothing when predicate matches no items", async () => {
		async function* source() {
			yield 1;
			yield 2;
			yield 3;
		}

		const result = await collect(
			filterAsync(source(), () => false),
		);

		expect(result).toEqual([]);
	});
});

describe("paginate + filterAsync (regression #115)", () => {
	/**
	 * Regression test for issue #115:
	 * When an entire page consists of items that would be filtered out
	 * (e.g. deleted resources), paginate must NOT stop early.
	 * Previously, filtering was done inside the paginate fetcher, which
	 * caused paginate to see an empty items array and break out of its
	 * loop even though hasMore was true.
	 *
	 * The fix moved filtering outside paginate via filterAsync.
	 */
	it("should not stop prematurely when a full page of items is filtered out", async () => {
		type Item = { name: string; deleted: boolean };

		// Page 1: two items, both deleted -- all will be filtered
		// Page 2: two items, both active -- these must still be yielded
		const fetcher: PageFetcher<Item, {}> = vi
			.fn()
			.mockResolvedValueOnce({
				items: [
					{ name: "del-1", deleted: true },
					{ name: "del-2", deleted: true },
				],
				hasMore: true,
			})
			.mockResolvedValueOnce({
				items: [
					{ name: "active-1", deleted: false },
					{ name: "active-2", deleted: false },
				],
				hasMore: false,
			});

		const allItems = paginate(fetcher, {}, (item) => item.name);
		const filtered = filterAsync(allItems, (item) => !item.deleted);

		const result = await collect(filtered);

		// The key assertion: we must still see items from page 2
		expect(result).toEqual([
			{ name: "active-1", deleted: false },
			{ name: "active-2", deleted: false },
		]);
		// Both pages must have been fetched
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("should handle multiple consecutive pages of filtered-out items", async () => {
		type Item = { name: string; deleted: boolean };

		// Pages 1, 2, 3: all deleted items
		// Page 4: active items
		const fetcher: PageFetcher<Item, {}> = vi
			.fn()
			.mockResolvedValueOnce({
				items: [{ name: "del-1", deleted: true }],
				hasMore: true,
			})
			.mockResolvedValueOnce({
				items: [{ name: "del-2", deleted: true }],
				hasMore: true,
			})
			.mockResolvedValueOnce({
				items: [{ name: "del-3", deleted: true }],
				hasMore: true,
			})
			.mockResolvedValueOnce({
				items: [
					{ name: "active-1", deleted: false },
					{ name: "active-2", deleted: false },
				],
				hasMore: false,
			});

		const allItems = paginate(fetcher, {}, (item) => item.name);
		const filtered = filterAsync(allItems, (item) => !item.deleted);

		const result = await collect(filtered);

		expect(result).toEqual([
			{ name: "active-1", deleted: false },
			{ name: "active-2", deleted: false },
		]);
		expect(fetcher).toHaveBeenCalledTimes(4);
	});

	it("should yield active items from mixed pages while skipping deleted ones", async () => {
		type Item = { name: string; deleted: boolean };

		// Page 1: mix of active and deleted
		// Page 2: all deleted
		// Page 3: mix of active and deleted
		const fetcher: PageFetcher<Item, {}> = vi
			.fn()
			.mockResolvedValueOnce({
				items: [
					{ name: "active-1", deleted: false },
					{ name: "del-1", deleted: true },
					{ name: "active-2", deleted: false },
				],
				hasMore: true,
			})
			.mockResolvedValueOnce({
				items: [
					{ name: "del-2", deleted: true },
					{ name: "del-3", deleted: true },
				],
				hasMore: true,
			})
			.mockResolvedValueOnce({
				items: [
					{ name: "del-4", deleted: true },
					{ name: "active-3", deleted: false },
				],
				hasMore: false,
			});

		const allItems = paginate(fetcher, {}, (item) => item.name);
		const filtered = filterAsync(allItems, (item) => !item.deleted);

		const result = await collect(filtered);

		expect(result).toEqual([
			{ name: "active-1", deleted: false },
			{ name: "active-2", deleted: false },
			{ name: "active-3", deleted: false },
		]);
		expect(fetcher).toHaveBeenCalledTimes(3);
	});

	it("should pass correct cursors through pages of deleted items", async () => {
		type Item = { name: string; deleted: boolean };

		const fetcher: PageFetcher<Item, {}> = vi
			.fn()
			.mockResolvedValueOnce({
				items: [{ name: "del-a", deleted: true }],
				hasMore: true,
			})
			.mockResolvedValueOnce({
				items: [{ name: "active-b", deleted: false }],
				hasMore: false,
			});

		const allItems = paginate(fetcher, {}, (item) => item.name);
		const filtered = filterAsync(allItems, (item) => !item.deleted);

		const result = await collect(filtered);

		expect(result).toEqual([{ name: "active-b", deleted: false }]);

		// Verify correct cursor was used for the second page fetch.
		// The cursor should be "del-a" (the last item from page 1),
		// even though that item will be filtered out.
		expect(fetcher).toHaveBeenNthCalledWith(1, { startAfter: undefined });
		expect(fetcher).toHaveBeenNthCalledWith(2, { startAfter: "del-a" });
	});

	it("should return empty when all pages contain only deleted items", async () => {
		type Item = { name: string; deleted: boolean };

		const fetcher: PageFetcher<Item, {}> = vi
			.fn()
			.mockResolvedValueOnce({
				items: [{ name: "del-1", deleted: true }],
				hasMore: true,
			})
			.mockResolvedValueOnce({
				items: [{ name: "del-2", deleted: true }],
				hasMore: false,
			});

		const allItems = paginate(fetcher, {}, (item) => item.name);
		const filtered = filterAsync(allItems, (item) => !item.deleted);

		const result = await collect(filtered);

		expect(result).toEqual([]);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});
