/**
 * Encode an unsigned 64-bit integer as an 8-byte big-endian Uint8Array.
 */
export function encodeU64(value: bigint | number): Uint8Array {
	const v = typeof value === "bigint" ? value : BigInt(value);
	const buffer = new ArrayBuffer(8);
	const view = new DataView(buffer);
	view.setBigUint64(0, v, false);
	return new Uint8Array(buffer);
}

/**
 * Decode an unsigned 64-bit integer from an 8-byte big-endian Uint8Array.
 */
export function decodeU64(bytes: Uint8Array): bigint {
	if (bytes.byteLength !== 8) {
		throw new Error(
			`decodeU64 expected 8 bytes, got ${bytes.byteLength} bytes`,
		);
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return view.getBigUint64(0, false);
}
