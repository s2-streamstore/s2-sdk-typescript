import { S2Error } from "../error.js";
import { encodeToBase64 } from "./base64.js";
import * as Redacted from "./redacted.js";

/**
 * Encryption algorithm for basin-level default stream encryption.
 */
export type EncryptionAlgorithm = "aegis-256" | "aes-256-gcm";

/**
 * Request header used for per-stream append/read encryption keys.
 */
export const S2_ENCRYPTION_KEY_HEADER = "s2-encryption-key";

/**
 * Maximum length of the base64-encoded encryption key header value.
 *
 * Matches the Rust SDK's `MAX_ENCRYPTION_KEY_HEADER_VALUE_LEN`.
 */
export const MAX_ENCRYPTION_KEY_HEADER_VALUE_LEN = 44;

function invalidEncryptionKeyLength(length: number): S2Error {
	return new S2Error({
		message: `invalid encryption key: key material length ${length} is out of range`,
		origin: "sdk",
		status: 422,
	});
}

/**
 * Helpers for customer-supplied encryption keys.
 *
 * Keys are passed to the SDK as base64-encoded strings. Use {@link fromBytes}
 * to convert raw key material into the base64 form expected by the API.
 */
export const EncryptionKey = {
	/**
	 * Validate and normalize a base64-encoded encryption key string.
	 *
	 * Trims surrounding whitespace and enforces the header length bound.
	 */
	from(value: string): string {
		const normalized = value.trim();

		if (
			normalized.length === 0 ||
			normalized.length > MAX_ENCRYPTION_KEY_HEADER_VALUE_LEN
		) {
			throw invalidEncryptionKeyLength(normalized.length);
		}

		return normalized;
	},

	/**
	 * Base64-encode raw key material and validate its length.
	 */
	fromBytes(bytes: Uint8Array): string {
		return EncryptionKey.from(encodeToBase64(bytes));
	},
};

export function resolveEncryptionKey(
	value: string | undefined | null,
): Redacted.Redacted<string> | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}

	return Redacted.make(EncryptionKey.from(value));
}
