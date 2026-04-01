/** Check if a record is a fence command (single header with empty key and "fence" value). */
export function isFenceRecord(record: {
	headers?:
		| ReadonlyArray<readonly [string, string]>
		| Array<[string, string]>
		| null;
}): boolean {
	return (
		record.headers?.length === 1 &&
		record.headers[0]![0] === "" &&
		record.headers[0]![1] === "fence"
	);
}

/** Check if a fence record body indicates stream completion (`end-*` or `error-*`). */
export function isTerminalFence(record: { body?: string | null }): boolean {
	return Boolean(
		record.body?.startsWith("end-") || record.body?.startsWith("error-"),
	);
}
