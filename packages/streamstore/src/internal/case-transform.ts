/**
 * Type-level and runtime utilities for converting between snake_case and camelCase.
 *
 * These utilities allow the SDK to expose camelCase APIs to users while the
 * generated types from OpenAPI use snake_case to match the wire format.
 */

// =============================================================================
// Type-Level Transformations
// =============================================================================

/**
 * Convert a snake_case string literal to camelCase at the type level.
 *
 * @example
 * type Result = SnakeToCamel<"seq_num">; // "seqNum"
 * type Result2 = SnakeToCamel<"created_at">; // "createdAt"
 */
export type SnakeToCamel<S extends string> =
	S extends `${infer Head}_${infer Tail}`
		? `${Head}${Capitalize<SnakeToCamel<Tail>>}`
		: S;

/**
 * Convert a camelCase string literal to snake_case at the type level.
 *
 * @example
 * type Result = CamelToSnake<"seqNum">; // "seq_num"
 * type Result2 = CamelToSnake<"createdAt">; // "created_at"
 */
export type CamelToSnake<S extends string> =
	S extends `${infer Head}${infer Tail}`
		? Head extends Uppercase<Head>
			? Head extends Lowercase<Head>
				? `${Head}${CamelToSnake<Tail>}`
				: `_${Lowercase<Head>}${CamelToSnake<Tail>}`
			: `${Head}${CamelToSnake<Tail>}`
		: S;

/**
 * Recursively transform all keys in an object type from snake_case to camelCase.
 *
 * @example
 * type API = { seq_num: number; created_at: string };
 * type SDK = CamelCaseKeys<API>; // { seqNum: number; createdAt: string }
 */
export type CamelCaseKeys<T> = T extends object
	? T extends Array<infer U>
		? Array<CamelCaseKeys<U>>
		: T extends ReadonlyArray<infer U>
			? ReadonlyArray<CamelCaseKeys<U>>
			: { [K in keyof T as SnakeToCamel<K & string>]: CamelCaseKeys<T[K]> }
	: T;

/**
 * Recursively transform all keys in an object type from camelCase to snake_case.
 *
 * @example
 * type SDK = { seqNum: number; createdAt: string };
 * type API = SnakeCaseKeys<SDK>; // { seq_num: number; created_at: string }
 */
export type SnakeCaseKeys<T> = T extends object
	? T extends Array<infer U>
		? Array<SnakeCaseKeys<U>>
		: T extends ReadonlyArray<infer U>
			? ReadonlyArray<SnakeCaseKeys<U>>
			: { [K in keyof T as CamelToSnake<K & string>]: SnakeCaseKeys<T[K]> }
	: T;

// =============================================================================
// Runtime Transformations
// =============================================================================

/**
 * Convert a snake_case string to camelCase at runtime.
 */
function snakeToCamelString(str: string): string {
	return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Convert a camelCase string to snake_case at runtime.
 */
function camelToSnakeString(str: string): string {
	return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Recursively transform all keys in an object from snake_case to camelCase at runtime.
 *
 * @example
 * const api = { seq_num: 123, created_at: "2024-01-01" };
 * const sdk = toCamelCase(api); // { seqNum: 123, createdAt: "2024-01-01" }
 */
export function toCamelCase<T>(obj: unknown): CamelCaseKeys<T> {
	if (obj === null || obj === undefined) {
		return obj as CamelCaseKeys<T>;
	}

	if (typeof obj !== "object") {
		return obj as CamelCaseKeys<T>;
	}

	if (Array.isArray(obj)) {
		return obj.map((item) => toCamelCase(item)) as CamelCaseKeys<T>;
	}

	// Handle Uint8Array and other typed arrays - don't transform
	if (ArrayBuffer.isView(obj)) {
		return obj as CamelCaseKeys<T>;
	}

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		result[snakeToCamelString(key)] = toCamelCase(value);
	}
	return result as CamelCaseKeys<T>;
}

/**
 * Recursively transform all keys in an object from camelCase to snake_case at runtime.
 *
 * @example
 * const sdk = { seqNum: 123, createdAt: "2024-01-01" };
 * const api = toSnakeCase(sdk); // { seq_num: 123, created_at: "2024-01-01" }
 */
export function toSnakeCase<T>(obj: unknown): SnakeCaseKeys<T> {
	if (obj === null || obj === undefined) {
		return obj as SnakeCaseKeys<T>;
	}

	if (typeof obj !== "object") {
		return obj as SnakeCaseKeys<T>;
	}

	if (Array.isArray(obj)) {
		return obj.map((item) => toSnakeCase(item)) as SnakeCaseKeys<T>;
	}

	// Handle Uint8Array and other typed arrays - don't transform
	if (ArrayBuffer.isView(obj)) {
		return obj as SnakeCaseKeys<T>;
	}

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		result[camelToSnakeString(key)] = toSnakeCase(value);
	}
	return result as SnakeCaseKeys<T>;
}
