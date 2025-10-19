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
	public readonly data?: Record<string, unknown>;

	constructor({
		message,
		code,
		status,
		data,
	}: {
		/** Human-readable error message. */
		message: string;
		code?: string;
		status?: number;
		/** Additional error details when available. */
		data?: Record<string, unknown>;
	}) {
		// Include full data in the error message for better visibility
		const dataStr = data ? `\nData: ${JSON.stringify(data, null, 2)}` : "";
		super(`${message}${dataStr}`);
		this.code = code;
		this.status = status;
		this.data = data;
		this.name = "S2Error";
	}

	public toString() {
		return `${this.message} (code: ${this.code}, status: ${this.status}, data: ${JSON.stringify(this.data, null, 2)})`;
	}

	public toJSON() {
		return {
			message: this.message,
			code: this.code,
			status: this.status,
			data: this.data,
		};
	}

	public [Symbol.for("nodejs.util.inspect.custom")]() {
		return {
			name: "S2Error",
			message: this.message,
			code: this.code,
			status: this.status,
			data: this.data,
			stack: this.stack,
		};
	}
}
