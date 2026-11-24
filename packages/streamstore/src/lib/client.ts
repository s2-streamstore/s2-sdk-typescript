import { S2Error } from "../error.js";
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
	let response: Response;
	try {
		// S2 never redirects, and following one would forward headers such as
		// `s2-encryption-key` to another host.
		response = await fetch(input, { ...init, redirect: "manual" });
	} catch (error) {
		const signal =
			init?.signal ?? (input instanceof Request ? input.signal : undefined);
		if (signal?.aborted) {
			throw new DOMException("Request cancelled", "AbortError");
		}
		throw error;
	}
	// Fail on the headers, so reading the body can't turn it into a retryable
	// error. Browsers hide a redirect's status, leaving it 0.
	if (
		response.type === "opaqueredirect" ||
		(response.status >= 300 && response.status < 400)
	) {
		void response.body?.cancel().catch(() => {});
		throw new S2Error({
			message: "unexpected HTTP redirect",
			status: response.status,
			origin: "server",
		});
	}
	return response;
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
