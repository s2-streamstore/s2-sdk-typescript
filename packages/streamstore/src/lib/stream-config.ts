import { toSnakeCase } from "../internal/case-transform.js";
import { toAPIStreamConfig } from "../internal/mappers.js";
import type * as Types from "../types.js";

/**
 * Header carrying a JSON-encoded stream config to apply if an append or read
 * auto-creates the stream. Ignored by the server if the stream already exists.
 */
export const S2_STREAM_CONFIG_HEADER = "s2-stream-config";

/** Encode a stream config as the `s2-stream-config` header value. */
export function streamConfigHeaderValue(config: Types.StreamConfig): string {
	return JSON.stringify(toSnakeCase(toAPIStreamConfig(config)));
}

/** Headers to attach for `config`, or `undefined` when there is none. */
export function streamConfigHeaders(
	config: Types.StreamConfig | undefined,
): Record<string, string> | undefined {
	if (!config) return undefined;
	return { [S2_STREAM_CONFIG_HEADER]: streamConfigHeaderValue(config) };
}
