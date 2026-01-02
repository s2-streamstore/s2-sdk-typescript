import { describe, expect, expectTypeOf, it } from "vitest";
import type * as API from "../generated/types.gen.js";
import {
	type CamelCaseKeys,
	type SnakeToCamel,
	toCamelCase,
	toSnakeCase,
} from "../internal/case-transform.js";
import type * as SDK from "../internal/sdk-types.js";

describe("case-transform", () => {
	describe("type-level transformations", () => {
		it("converts snake_case to camelCase string literals", () => {
			type Result1 = SnakeToCamel<"seq_num">;
			type Result2 = SnakeToCamel<"created_at">;
			type Result3 = SnakeToCamel<"auto_prefix_streams">;
			type Result4 = SnakeToCamel<"name">; // no underscore

			expectTypeOf<Result1>().toEqualTypeOf<"seqNum">();
			expectTypeOf<Result2>().toEqualTypeOf<"createdAt">();
			expectTypeOf<Result3>().toEqualTypeOf<"autoPrefixStreams">();
			expectTypeOf<Result4>().toEqualTypeOf<"name">();
		});

		it("converts object keys from snake_case to camelCase", () => {
			type APIType = {
				seq_num: number;
				created_at: string;
				nested_obj: {
					has_more: boolean;
					access_tokens: string[];
				};
			};

			type SDKType = CamelCaseKeys<APIType>;

			expectTypeOf<SDKType>().toEqualTypeOf<{
				seqNum: number;
				createdAt: string;
				nestedObj: {
					hasMore: boolean;
					accessTokens: string[];
				};
			}>();
		});

		it("handles arrays correctly", () => {
			type APIType = {
				items: Array<{ seq_num: number }>;
			};

			type SDKType = CamelCaseKeys<APIType>;

			expectTypeOf<SDKType>().toEqualTypeOf<{
				items: Array<{ seqNum: number }>;
			}>();
		});
	});

	describe("runtime toCamelCase", () => {
		it("converts simple object keys", () => {
			const input = { seq_num: 123, created_at: "2024-01-01" };
			const result = toCamelCase(input);

			expect(result).toEqual({ seqNum: 123, createdAt: "2024-01-01" });
		});

		it("converts nested objects", () => {
			const input = {
				seq_num: 123,
				nested_obj: {
					has_more: true,
					start_after: "foo",
				},
			};
			const result = toCamelCase(input);

			expect(result).toEqual({
				seqNum: 123,
				nestedObj: {
					hasMore: true,
					startAfter: "foo",
				},
			});
		});

		it("converts arrays of objects", () => {
			const input = {
				access_tokens: [
					{ token_id: "a", expires_at: "2024-01-01" },
					{ token_id: "b", expires_at: "2024-02-01" },
				],
			};
			const result = toCamelCase(input);

			expect(result).toEqual({
				accessTokens: [
					{ tokenId: "a", expiresAt: "2024-01-01" },
					{ tokenId: "b", expiresAt: "2024-02-01" },
				],
			});
		});

		it("handles null and undefined", () => {
			expect(toCamelCase(null)).toBe(null);
			expect(toCamelCase(undefined)).toBe(undefined);
		});

		it("handles primitives", () => {
			expect(toCamelCase(123)).toBe(123);
			expect(toCamelCase("hello")).toBe("hello");
			expect(toCamelCase(true)).toBe(true);
		});

		it("does not transform Uint8Array", () => {
			const bytes = new Uint8Array([1, 2, 3]);
			const input = { body_data: bytes };
			const result = toCamelCase<{ bodyData: Uint8Array }>(input);

			expect(result.bodyData).toBe(bytes);
			expect(result.bodyData).toBeInstanceOf(Uint8Array);
		});
	});

	describe("runtime toSnakeCase", () => {
		it("converts simple object keys", () => {
			const input = { seqNum: 123, createdAt: "2024-01-01" };
			const result = toSnakeCase(input);

			expect(result).toEqual({ seq_num: 123, created_at: "2024-01-01" });
		});

		it("converts nested objects", () => {
			const input = {
				seqNum: 123,
				nestedObj: {
					hasMore: true,
					startAfter: "foo",
				},
			};
			const result = toSnakeCase(input);

			expect(result).toEqual({
				seq_num: 123,
				nested_obj: {
					has_more: true,
					start_after: "foo",
				},
			});
		});

		it("is inverse of toCamelCase", () => {
			const original = {
				seq_num: 123,
				created_at: "2024-01-01",
				nested_obj: {
					has_more: true,
				},
			};

			const camelCase = toCamelCase(original);
			const backToSnake = toSnakeCase(camelCase);

			expect(backToSnake).toEqual(original);
		});
	});

	describe("SDK wrapped types", () => {
		it("transforms BasinConfig keys to camelCase", () => {
			// SDK.BasinConfig should have camelCase keys
			type Config = SDK.BasinConfig;

			// These should compile - proving the type transformation works
			const config: Config = {
				createStreamOnAppend: true,
				createStreamOnRead: false,
				defaultStreamConfig: {
					deleteOnEmpty: { minAgeSecs: 3600 },
					retentionPolicy: { age: 86400 }, // Uses API field name; SDK types use ageSecs
					storageClass: "standard",
					timestamping: { mode: "arrival" },
				},
			};

			expect(config.createStreamOnAppend).toBe(true);
			expect(config.defaultStreamConfig?.deleteOnEmpty?.minAgeSecs).toBe(3600);
		});

		it("transforms StreamInfo keys to camelCase", () => {
			type Info = SDK.StreamInfo;

			const info: Info = {
				name: "my-stream",
				createdAt: "2024-01-01T00:00:00Z",
				deletedAt: null,
			};

			expect(info.createdAt).toBe("2024-01-01T00:00:00Z");
		});

		it("transforms ListBasinsResponse keys to camelCase", () => {
			type Response = SDK.ListBasinsResponse;

			const response: Response = {
				basins: [{ name: "my-basin", scope: "aws:us-east-1", state: "active" }],
				hasMore: false,
			};

			expect(response.hasMore).toBe(false);
		});

		it("transforms AccessTokenInfo keys to camelCase", () => {
			type Info = SDK.AccessTokenInfo;

			const info: Info = {
				id: "my-token",
				autoPrefixStreams: true,
				expiresAt: "2024-12-31T00:00:00Z",
				scope: {
					accessTokens: { prefix: "" },
					basins: { exact: "my-basin" },
					opGroups: { account: { read: true } },
				},
			};

			expect(info.autoPrefixStreams).toBe(true);
			expect(info.scope.opGroups?.account?.read).toBe(true);
		});

		it("transforms SequencedRecord keys to camelCase", () => {
			type Record = SDK.SequencedRecord;

			const record: Record = {
				seqNum: 42,
				timestamp: 1704067200000,
				body: "hello",
				headers: [["key", "value"]],
			};

			expect(record.seqNum).toBe(42);
		});
	});
});
