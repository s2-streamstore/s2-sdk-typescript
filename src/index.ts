/** Access token management helpers and argument types. */

export type {
	IssueAccessTokenArgs,
	ListAccessTokensArgs,
	RevokeAccessTokenArgs,
} from "./accessTokens.js";
export { S2AccessTokens } from "./accessTokens.js";
/** Basin-scoped stream options. */
export type { StreamOptions } from "./basin.js";
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
/** Basin management helper. */
export { S2Basins } from "./basins.js";
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
/** Low-level generated HTTP client types. */
export type { Client } from "./generated/client/types.gen.js";
/**
 * Generated API types re-exported for convenience.
 *
 * These mirror the server REST resources and payloads.
 */
export type {
	AccessTokenIdStr,
	AccessTokenInfo,
	AccessTokenScope,
	AccountMetricSet,
	AccumulationMetric,
	AppendAck,
	AppendInput,
	AppendRecord as GeneratedAppendRecord,
	BasinConfig,
	BasinInfo,
	BasinMetricSet,
	BasinNameStr,
	BasinReconfiguration,
	BasinScope,
	BasinState,
	CreateStreamRequest,
	DeleteOnEmptyConfig,
	DeleteOnEmptyReconfiguration,
	FencingToken,
	GaugeMetric,
	Header,
	InfiniteRetention,
	IssueAccessTokenResponse,
	LabelMetric,
	ListAccessTokensResponse,
	ListBasinsResponse,
	ListStreamsResponse,
	Metric,
	MetricSetResponse,
	MetricUnit,
	Operation,
	PermittedOperationGroups,
	ReadBatch as GeneratedReadBatch,
	ReadData,
	ReadWritePermissions,
	ResourceSet,
	RetentionPolicy,
	S2Format,
	ScalarMetric,
	SequencedRecord,
	StorageClass,
	StreamConfig,
	StreamInfo,
	StreamMetricSet,
	StreamNameStr,
	StreamPosition,
	StreamReconfiguration,
	TailResponse,
	TimeseriesInterval,
	TimestampingConfig,
	TimestampingMode,
	TimestampingReconfiguration,
	U64,
} from "./generated/types.gen.js";
/** Redacted access token wrapper type. */
export type { Redacted } from "./lib/redacted.js";
/**
 * Streaming types used for reading from streams.
 */
export type {
	AcksStream,
	AppendArgs,
	AppendHeaders,
	AppendRecord as AppendRecordType,
	AppendRecordForFormat,
	AppendSession,
	AppendSessionOptions,
	ReadArgs,
	ReadBatch,
	ReadHeaders,
	ReadRecord,
	ReadResult,
	ReadSession,
	SessionTransports,
	TransportConfig,
} from "./lib/stream/types.js";
export type {
	AccountMetricsArgs,
	BasinMetricsArgs,
	StreamMetricsArgs,
} from "./metrics.js";
/** Metrics helper and argument types. */
export { S2Metrics } from "./metrics.js";
/** Top-level entrypoint for the SDK. */
export { S2 } from "./s2.js";
export { S2Stream } from "./stream.js";
export type {
	CreateStreamArgs,
	DeleteStreamArgs,
	GetStreamConfigArgs,
	ListStreamsArgs,
	ReconfigureStreamArgs,
} from "./streams.js";
/** Stream management helper and argument types. */
export { S2Streams } from "./streams.js";

/**
 * Low-level utilities for record bodies.
 *
 * - {@link AppendRecord} helps construct appendable records.
 * - {@link meteredBytes} and {@link utf8ByteLength} expose sizing utilities.
 */
export { AppendRecord, meteredBytes, utf8ByteLength } from "./utils.js";
