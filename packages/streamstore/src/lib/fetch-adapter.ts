import type { FetchLike } from "../common.js";

/**
 * A `(url, init)`-style fetch that cannot accept `Request` objects,
 * such as `expo/fetch`.
 */
export type UrlAndInitFetch = (
	url: string,
	init?: {
		method?: string;
		headers?: [string, string][];
		body?: BodyInit;
		signal?: AbortSignal;
	},
) => Promise<Response>;

/**
 * Adapt a `(url, init)`-style fetch into the {@link FetchLike} shape the SDK
 * invokes. The SDK always calls fetch with a single `Request` argument;
 * implementations like `expo/fetch` treat their first argument as a URL
 * string, so the request must be unpacked for them.
 *
 * Bodies are buffered, which is fine for the SDK's requests (appends are
 * discrete HTTP requests on the fetch transport; only responses stream).
 */
export const adaptFetch =
	(impl: UrlAndInitFetch): FetchLike =>
	async (request) => {
		const body =
			request.method === "GET" || request.method === "HEAD"
				? undefined
				: new Uint8Array(await request.arrayBuffer());
		const headers: [string, string][] = [];
		request.headers.forEach((value, name) => {
			headers.push([name, value]);
		});
		return impl(request.url, {
			method: request.method,
			headers,
			body: body && body.byteLength > 0 ? body : undefined,
			signal: request.signal,
		});
	};
