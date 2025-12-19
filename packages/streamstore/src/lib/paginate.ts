import createDebug from "debug";

const debug = createDebug("s2:paginate");

/**
 * A function that fetches a single page of results.
 * @template TItem The type of items in the page
 * @template TArgs The query arguments type (excluding start_after)
 */
export type PageFetcher<TItem, TArgs> = (
	args: TArgs & { start_after?: string },
) => Promise<{ items: TItem[]; has_more: boolean }>;

/**
 * Arguments for listAll pagination methods.
 * Omits start_after since pagination is handled automatically.
 */
export type ListAllArgs<TArgs> = Omit<TArgs, "start_after">;

/**
 * Creates a lazy async iterable that automatically paginates through all results.
 *
 * @template TItem The type of items being paginated
 * @template TArgs The query arguments type
 * @param fetcher Function that fetches a single page of results
 * @param args Query arguments (start_after is managed internally)
 * @param getCursor Function to extract the cursor value from an item for the next page
 * @returns An async iterable that yields items one at a time, fetching pages as needed
 *
 * @example
 * ```ts
 * const allBasins = paginate(
 *   (args) => this.list(args).then(r => ({ items: r.basins, has_more: r.has_more })),
 *   { prefix: "my-" },
 *   (basin) => basin.name
 * );
 *
 * for await (const basin of allBasins) {
 *   console.log(basin.name);
 * }
 * ```
 */
export function paginate<TItem, TArgs>(
	fetcher: PageFetcher<TItem, TArgs>,
	args: TArgs,
	getCursor: (item: TItem) => string,
): AsyncIterable<TItem> {
	return {
		[Symbol.asyncIterator]: async function* () {
			let cursor: string | undefined;

			while (true) {
				debug({ args, cursor });
				const { items, has_more } = await fetcher({
					...args,
					start_after: cursor,
				});

				for (const item of items) {
					yield item;
				}

				if (!has_more || items.length === 0) {
					break;
				}

				// Safe: we just checked items.length > 0
				cursor = getCursor(items[items.length - 1]!);
			}
		},
	};
}
