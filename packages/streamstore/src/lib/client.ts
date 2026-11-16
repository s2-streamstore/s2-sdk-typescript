import {
	type Client,
	createClient,
	createConfig,
} from "../generated/client/index.js";

/**
 * `fetch` that rejects with an `AbortError` once its signal has aborted,
 * whatever reason the caller passed to `abort()`, so `s2Error` reports it as
 * `ABORTED`. It maps the rejection rather than relaying the signal: on Bun a
 * request's signal is the caller's own, which may outlive many requests.
 */
async function fetchReportingAborts(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	try {
		return await fetch(input, init);
	} catch (error) {
		const signal =
			init?.signal ?? (input instanceof Request ? input.signal : undefined);
		if (signal?.aborted) {
			throw new DOMException("Request cancelled", "AbortError");
		}
		throw error;
	}
}

/** A client for the generated API whose aborted requests fail with `ABORTED`. */
export function createApiClient(
	baseUrl: string,
	auth: () => string,
	headers: Record<string, string>,
): Client {
	return createClient(
		createConfig({
			baseUrl,
			auth,
			headers,
			// Cast: some runtimes' `typeof fetch` carries extra members, such as Bun's `preconnect`.
			fetch: fetchReportingAborts as typeof fetch,
		}),
	);
}
