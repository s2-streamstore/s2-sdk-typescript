function isConnectionError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	if (error.message.includes("fetch failed")) {
		return true;
	}

	const cause = (error as any).cause;
	let code = (error as any).code;
	if (cause && typeof cause === "object") {
		code = cause.code;
	}

	// Common connection error codes from Node.js net module
	const connectionErrorCodes = [
		"ECONNREFUSED", // Connection refused
		"ENOTFOUND", // DNS lookup failed
		"ETIMEDOUT", // Connection timeout
		"ENETUNREACH", // Network unreachable
		"EHOSTUNREACH", // Host unreachable
		"ECONNRESET", // Connection reset by peer
		"EPIPE", // Broken pipe
	];

	if (connectionErrorCodes.includes(code)) {
		return true;
	}

	return false;
}

export function s2Error(error: any): S2Error {
	if (error instanceof S2Error) {
		return error;
	}

	// Connection error?
	if (isConnectionError(error)) {
		const cause = (error as any).cause;
		const code = cause?.code || "NETWORK_ERROR";
		return new S2Error({
			message: `Connection failed: ${code}`,
			status: 502, // Bad Gateway for upstream/network issues
			origin: "sdk",
		});
	}

	// Abort error?
	if (error instanceof Error && error.name === "AbortError") {
		return new S2Error({
			message: "Request cancelled",
			status: 499, // Client Closed Request (nginx non-standard)
			origin: "sdk",
		});
	}

	// Other unknown errors
	return new S2Error({
		message: error instanceof Error ? error.message : "Unknown error",
		status: 0, // Non-HTTP/internal error sentinel
		origin: "sdk",
	});
}

export async function withS2Error<T>(fn: () => Promise<T>): Promise<T> {
	try {
		const result: any = await fn();

		// Support response-parsing mode (throwOnError=false):
		// Generated client responses have shape { data, error?, response }
		if (
			result &&
			typeof result === "object" &&
			Object.prototype.hasOwnProperty.call(result, "error")
		) {
			const err = result.error;
			if (err) {
				const status = (result.response?.status as number | undefined) ?? 500;
				const statusText = result.response?.statusText as string | undefined;

				// If server provided structured error with message/code, use it
				if (typeof err === "object" && "message" in err) {
					throw new S2Error({
						message: (err as any).message ?? statusText ?? "Error",
						code: (err as any).code ?? undefined,
						status,
						origin: "server",
					});
				}

				// Fallback: synthesize from HTTP response metadata
				throw new S2Error({
					message: statusText ?? "Request failed",
					status,
					origin: "server",
				});
			}
		}

		return result as T;
	} catch (error) {
		// Network and other thrown errors
		throw s2Error(error);
	}
}

/**
 * Execute a generated client call and return its `data` on success.
 * Throws S2Error when the response contains `error`, or when the
 * response has no `data` and is not a 204 No Content.
 */
export async function withS2Data<T>(
	fn: () => Promise<
		| {
				data?: T;
				error?: unknown;
				response?: { status?: number; statusText?: string };
		  }
		| T
	>,
): Promise<T> {
	try {
		const res: any = await fn();
		if (
			res &&
			typeof res === "object" &&
			(Object.prototype.hasOwnProperty.call(res, "error") ||
				Object.prototype.hasOwnProperty.call(res, "data") ||
				Object.prototype.hasOwnProperty.call(res, "response"))
		) {
			const status = (res.response?.status as number | undefined) ?? 500;
			const statusText = res.response?.statusText as string | undefined;
			if (res.error) {
				const err = res.error;
				if (typeof err === "object" && "message" in err) {
					throw new S2Error({
						message: (err as any).message ?? statusText ?? "Error",
						code: (err as any).code ?? undefined,
						status,
						origin: "server",
					});
				}
				throw new S2Error({
					message: statusText ?? "Request failed",
					status,
					origin: "server",
				});
			}
			// No error
			if (typeof res.data !== "undefined") return res.data as T;
			// Treat 204 as success for void endpoints
			if (status === 204) return undefined as T;
			throw new S2Error({
				message: "Empty response",
				status,
				origin: "server",
			});
		}
		// Not a generated client response; return as-is
		return res as T;
	} catch (error) {
		throw s2Error(error);
	}
}

/**
 * Rich error type used by the SDK to surface HTTP and protocol errors.
 *
 * - `code` is the service error code when available.
 * - `status` is the HTTP status code.
 * - `data` may include structured error details (e.g. for conditional failures).
 */
export class S2Error extends Error {
	public readonly code?: string;
	public readonly status: number;
	/** Optional structured error details for diagnostics. */
	public readonly data?: unknown;
	/** Origin of the error: server (HTTP response) or sdk (local). */
	public readonly origin: "server" | "sdk";

	constructor({
		message,
		code,
		status,
		data,
		origin,
	}: {
		message: string;
		code?: string;
		status?: number;
		data?: unknown;
		origin?: "server" | "sdk";
	}) {
		super(message);
		this.code = code;
		// Ensure status is always a number (0 for non-HTTP/internal errors)
		this.status = typeof status === "number" ? status : 0;
		this.data = data;
		this.origin = origin ?? "sdk";
		this.name = "S2Error";
	}
}

/** Helper: construct a non-retryable invariant violation error (400). */
export function invariantViolation(
	message: string,
	details?: unknown,
): S2Error {
	return new S2Error({
		message: `Invariant violation: ${message}`,
		code: "INTERNAL_ERROR",
		status: 500,
		origin: "sdk",
		data: details,
	});
}

/** Helper: construct an internal SDK error (status 0, never retried). */
export function internalSdkError(message: string, details?: unknown): S2Error {
	return new S2Error({
		message: `Internal SDK error: ${message}`,
		code: "INTERNAL_SDK_ERROR",
		status: 0,
		origin: "sdk",
		data: details,
	});
}

/** Helper: construct an aborted/cancelled error (499). */
export function abortedError(message: string = "Request cancelled"): S2Error {
	return new S2Error({
		message,
		code: "ABORTED",
		status: 499,
		origin: "sdk",
	});
}

/**
 * Thrown when an append operation fails due to a sequence number mismatch.
 *
 * This occurs when you specify a `matchSeqNum` condition in your append request,
 * but the current tail sequence number of the stream doesn't match.
 *
 * The `expectedSeqNum` property contains the actual next sequence number
 * that should be used for a successful append.
 */
export class SeqNumMismatchError extends S2Error {
	/** The expected next sequence number for the stream. */
	public readonly expectedSeqNum: number;

	constructor({
		message,
		code,
		status,
		expectedSeqNum,
	}: {
		message: string;
		code?: string;
		status?: number;
		expectedSeqNum: number;
	}) {
		super({
			message: `${message}\nExpected sequence number: ${expectedSeqNum}`,
			code,
			status,
			origin: "server",
		});
		this.name = "SeqNumMismatchError";
		this.expectedSeqNum = expectedSeqNum;
	}
}

/**
 * Thrown when an append operation fails due to a fencing token mismatch.
 *
 * This occurs when you specify a `fencingToken` condition in your append request,
 * but the current fencing token of the stream doesn't match.
 *
 * The `expectedFencingToken` property contains the actual fencing token
 * that should be used for a successful append.
 */
export class FencingTokenMismatchError extends S2Error {
	/** The expected fencing token for the stream. */
	public readonly expectedFencingToken: string;

	constructor({
		message,
		code,
		status,
		expectedFencingToken,
	}: {
		message: string;
		code?: string;
		status?: number;
		expectedFencingToken: string;
	}) {
		super({
			message: `${message}\nExpected fencing token: ${expectedFencingToken}`,
			code,
			status,
			origin: "server",
		});
		this.name = "FencingTokenMismatchError";
		this.expectedFencingToken = expectedFencingToken;
	}
}

/**
 * Thrown when a read operation fails because the requested position is beyond the stream tail.
 *
 * This occurs when you specify a `startSeqNum` that is greater than the current tail
 * of the stream (HTTP 416 Range Not Satisfiable).
 *
 * To handle this gracefully, you can set `clamp: true` in your read options to
 * automatically start from the tail instead of throwing an error.
 */
export class RangeNotSatisfiableError extends S2Error {
	constructor({
		message = "Range not satisfiable: requested position is beyond the stream tail. Use 'clamp: true' to start from the tail instead.",
		code,
		status = 416,
	}: {
		message?: string;
		code?: string;
		status?: number;
	} = {}) {
		super({
			message,
			code,
			status,
			origin: "server",
		});
		this.name = "RangeNotSatisfiableError";
	}
}
