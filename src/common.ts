/**
 * Configuration for constructing the top-level `S2` client.
 *
 * - The client authenticates using a Bearer access token on every request.
 */
export type S2ClientOptions = {
	/**
	 * Access token used for HTTP Bearer authentication.
	 * Typically obtained via your S2 account or created using `s2.accessTokens.issue`.
	 */
	accessToken: string;
};

/**
 * Per-request options that apply to all SDK operations.
 */
export type S2RequestOptions = {
	/**
	 * Optional abort signal to cancel the underlying HTTP request.
	 */
	signal?: AbortSignal;
};

/**
 * Helper type that flattens an endpoint's `body`, `path` and `query` into a
 * single object. This lets public methods accept one coherent argument object
 * instead of three separate bags.
 */
export type DataToObject<T> = (T extends { body: infer B } ? B : {}) &
	(T extends { path: infer P } ? P : {}) &
	(T extends { query: infer Q } ? Q : {});
