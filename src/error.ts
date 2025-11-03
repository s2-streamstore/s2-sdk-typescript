function isConnectionError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	if (error.message.includes("fetch failed")) {
		return true;
	}

	const cause = (error as any).cause;
	if (cause && typeof cause === "object") {
		const code = cause.code;

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
	}

	return false;
}

export async function withS2Error<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		// Already S2Error? Rethrow
		if (error instanceof S2Error) {
			throw error;
		}

		// Connection error?
		if (isConnectionError(error)) {
			const cause = (error as any).cause;
			const code = cause?.code || "NETWORK_ERROR";
			throw new S2Error({
				message: `Connection failed: ${code}`,
				// Could add a specific status or property for connection errors
				status: 500, // or 0, or a constant
			});
		}

		// Abort error?
		if (error instanceof Error && error.name === "AbortError") {
			throw new S2Error({
				message: "Request cancelled",
				status: undefined,
			});
		}

		// Other unknown errors
		throw new S2Error({
			message: error instanceof Error ? error.message : "Unknown error",
			status: 0,
		});
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
	public readonly status?: number;

	constructor({
		message,
		code,
		status,
	}: {
		message: string;
		code?: string;
		status?: number;
	}) {
		super(message);
		this.code = code;
		this.status = status;
		this.name = "S2Error";
	}
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
		});
		this.name = "RangeNotSatisfiableError";
	}
}
