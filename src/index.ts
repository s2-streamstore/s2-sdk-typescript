/**
 * Access token management argument types.
 * Use these with {@link S2AccessTokens} methods.
 */
export type {
	IssueAccessTokenArgs,
	ListAccessTokensArgs,
	RevokeAccessTokenArgs,
} from "./accessTokens.js";
export { S2Basin } from "./basin.js";
/**
 * Basin management argument types.
 * Use these with {@link S2Basins} and {@link S2Basin}.
 */
export type {
	CreateBasinArgs,
	DeleteBasinArgs,
	GetBasinConfigArgs,
	ListBasinsArgs,
	ReconfigureBasinArgs,
} from "./basins.js";
/** Types used with {@link BatchTransform}. */
export type { BatchOutput, BatchTransformArgs } from "./batch-transform.js";
/** High-level helper for transforming streams in batches. */
export { BatchTransform } from "./batch-transform.js";
/** Client configuration and retry-related types. */
export type {
	AppendRetryPolicy,
	RetryConfig,
	S2ClientOptions,
	S2RequestOptions,
} from "./common.js";
/**
 * Rich error types exposed by the SDK.
 *
 * - {@link S2Error} is the base error type.
 * - Other types specialize common protocol errors.
 */
export {
	FencingTokenMismatchError,
	RangeNotSatisfiableError,
	S2Error,
	SeqNumMismatchError,
} from "./error.js";
/**
 * Generated API types re-exported for convenience.
 *
 * These mirror the server REST resources and payloads.
 */
export type {
	AccessTokenInfo,
	AccessTokenScope,
	AccountMetricSet,
	AccumulationMetric,
	BasinConfig,
	BasinInfo,
	BasinMetricSet,
	BasinReconfiguration,
	BasinScope,
	CreateStreamRequest,
	DeleteOnEmptyConfig,
	GaugeMetric,
	IssueAccessTokenResponse,
	LabelMetric,
	ListAccessTokensResponse,
	ListBasinsResponse,
	ListStreamsResponse,
	Metric,
	MetricSetResponse,
	Operation,
	PermittedOperationGroups,
	ReadWritePermissions,
	ResourceSet,
	RetentionPolicy,
	StorageClass,
	StreamConfig,
	StreamInfo,
	StreamMetricSet,
	TimeseriesInterval,
	TimestampingConfig,
	TimestampingMode,
} from "./generated/types.gen.js";
/**
 * Streaming types used for reading from streams.
 *
 * - {@link ReadSession} is a retrying, streaming reader.
 * - {@link ReadRecord} represents a decoded record.
 */
export type {
	AppendArgs,
	ReadArgs,
	ReadBatch,
	ReadRecord,
	ReadSession,
} from "./lib/stream/types.js";
/** Argument types used with {@link S2Metrics}. */
export type {
	AccountMetricsArgs,
	BasinMetricsArgs,
	StreamMetricsArgs,
} from "./metrics.js";
/** Top-level entrypoint for the SDK. */
export { S2 } from "./s2.js";
export { S2Stream } from "./stream.js";

/** Stream management argument types used with {@link S2Streams}. */
export type {
	CreateStreamArgs,
	DeleteStreamArgs,
	GetStreamConfigArgs,
	ListStreamsArgs,
	ReconfigureStreamArgs,
} from "./streams.js";

/**
 * Low-level utilities for record bodies.
 *
 * - {@link AppendRecord} helps construct appendable records.
 * - {@link meteredSizeBytes} and {@link utf8ByteLength} expose sizing utilities.
 */
export { AppendRecord, meteredSizeBytes, utf8ByteLength } from "./utils.js";
