/**
 * `fetch` that always rejects, and errors the response body, with an
 * `AbortError` once its signal aborts. Plain `fetch` uses whatever reason the
 * caller passed to `abort()`, which `s2Error` cannot tell from other failures.
 */
function abortErrorFetch(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	const signal =
		init?.signal ?? (input instanceof Request ? input.signal : undefined);
	if (!signal) {
		return fetch(input, init);
	}
	const controller = new AbortController();
	const relay = () =>
		controller.abort(new DOMException("Request cancelled", "AbortError"));
	if (signal.aborted) {
		relay();
	} else {
		signal.addEventListener("abort", relay, { once: true });
	}
	return fetch(input, { ...init, signal: controller.signal });
}

// Cast: some runtimes' `typeof fetch` carries extra members, such as Bun's `preconnect`.
export const fetchWithAbortError = abortErrorFetch as typeof fetch;
