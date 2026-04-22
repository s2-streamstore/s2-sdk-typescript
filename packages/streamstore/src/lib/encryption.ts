import { S2Error } from "../error.js";
import { encodeToBase64 } from "./base64.js";
import * as Redacted from "./redacted.js";

/**
 * Encryption algorithm for basin-level default stream encryption.
 */
export type EncryptionAlgorithm = "aegis-256" | "aes-256-gcm";

/**
 * Accepted input for customer-supplied encryption keys.
 *
 * - `string`: base64-encoded key material
 * - `Uint8Array`: raw key material, which will be base64-encoded automatically
 */
export type EncryptionKeyInput = string | Uint8Array;

/**
 * Request header used for per-stream append/read encryption keys.
 */
export const S2_ENCRYPTION_KEY_HEADER = "s2-encryption-key";

export const MAX_ENCRYPTION_KEY_HEADER_VALUE_LEN = 44;

export class EncryptionKeyLengthError extends S2Error {
	public readonly length: number;

	constructor(length: number) {
		super({
			message: `invalid encryption key: key material length ${length} is out of range`,
			origin: "sdk",
		});
		this.length = length;
		this.name = "EncryptionKeyLengthError";
	}
}

/**
 * Helpers for normalizing customer-supplied encryption keys.
 */
export const EncryptionKey = {
	/**
	 * Normalize key material into the base64-encoded header form accepted by S2.
	 */
	from(value: EncryptionKeyInput): string {
		const normalized =
			typeof value === "string" ? value.trim() : encodeToBase64(value);
		const keyMaterialLength =
			typeof value === "string" ? normalized.length : value.byteLength;

		if (
			normalized.length === 0 ||
			normalized.length > MAX_ENCRYPTION_KEY_HEADER_VALUE_LEN
		) {
			throw new EncryptionKeyLengthError(keyMaterialLength);
		}

		return normalized;
	},
};

export function resolveEncryptionKey(
	value: EncryptionKeyInput | undefined | null,
): Redacted.Redacted<string> | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}

	return Redacted.make(EncryptionKey.from(value));
}
