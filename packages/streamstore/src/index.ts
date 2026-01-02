// =============================================================================
// Core Client
// =============================================================================

export { S2Basin } from "./basin.js";
/** Top-level entrypoint for the SDK. */
export { S2 } from "./s2.js";
export { S2Stream } from "./stream.js";

// =============================================================================
// Management Classes
// =============================================================================

export { S2AccessTokens } from "./accessTokens.js";
export { S2Basins } from "./basins.js";
export { S2Metrics } from "./metrics.js";
export { S2Streams } from "./streams.js";

// =============================================================================
// High-Level Helpers
// =============================================================================

/** High-level helper for transforming streams in batches. */
export { BatchTransform } from "./batch-transform.js";
/** High-level producer with automatic batching. */
export { IndexedAppendAck, Producer, RecordSubmitTicket } from "./producer.js";

// =============================================================================
// SDK Types
// =============================================================================

// Core types for streaming operations
// Stream types
// Basin types
// Access token types
// Metrics types
export type {
	AccessTokenInfo,
	AccessTokenScope,
	AccountMetricsInput,
	AccumulationMetric,
	AppendAck,
	AppendSessionOptions,
	BasinConfig,
	BasinInfo,
	BasinMetricsInput,
	BytesAppendRecord,
	CreateBasinInput,
	CreateBasinResponse,
	CreateStreamInput,
	CreateStreamResponse,
	DeleteBasinInput,
	DeleteOnEmptyConfig,
	DeleteStreamInput,
	GaugeMetric,
	GetBasinConfigInput,
	GetStreamConfigInput,
	IssueAccessTokenInput,
	IssueAccessTokenResponse,
	LabelMetric,
	ListAccessTokensInput,
	ListAccessTokensResponse,
	ListAllAccessTokensInput,
	ListAllBasinsInput,
	ListAllStreamsInput,
	ListBasinsInput,
	ListBasinsResponse,
	ListStreamsInput,
	ListStreamsResponse,
	Metric,
	MetricSetResponse,
	ReadBatch,
	ReadFrom,
	ReadInput,
	ReadLimits,
	ReadRecord,
	ReadStart,
	ReadStop,
	ReconfigureBasinInput,
	ReconfigureBasinResponse,
	ReconfigureStreamInput,
	ReconfigureStreamResponse,
	RevokeAccessTokenInput,
	ScalarMetric,
	StreamConfig,
	StreamInfo,
	StreamMetricsInput,
	StreamPosition,
	StringAppendRecord,
	TailResponse,
	TimestampingConfig,
} from "./types.js";
/**
 * Record types and factory functions for append operations.
 *
 * Use `AppendRecord.string()`, `AppendRecord.bytes()` to create records.
 * Use `AppendInput.create()` to create validated append inputs.
 */
export {
	AppendInput,
	AppendRecord,
	MAX_APPEND_BYTES,
	MAX_APPEND_RECORDS,
} from "./types.js";

// =============================================================================
// API Types (Wire Format)
// =============================================================================

// Commonly used enums and config types (re-exported for convenience)
export type {
	// Metric types
	AccountMetricSet,
	BasinMetricSet,
	// Enums and string literals
	BasinScope,
	BasinState,
	// Retention
	InfiniteRetention,
	Operation,
	// Scope configuration
	PermittedOperationGroups,
	ResourceSet,
	RetentionPolicy,
	StorageClass,
	StreamMetricSet,
	TimeseriesInterval,
	TimestampingMode,
} from "./generated/types.gen.js";
/**
 * Generated API types matching the wire format (snake_case field names).
 * Use these when you need to work with raw API data or understand the wire protocol.
 */
export * as API from "./generated/types.gen.js";

// =============================================================================
// Client Configuration
// =============================================================================

export type {
	AppendRetryPolicy,
	RetryConfig,
	S2ClientOptions,
	S2RequestOptions,
} from "./common.js";

// =============================================================================
// Error Types
// =============================================================================

export {
	FencingTokenMismatchError,
	RangeNotSatisfiableError,
	S2Error,
	SeqNumMismatchError,
} from "./error.js";

// =============================================================================
// Streaming Types
// =============================================================================

export type { StreamOptions } from "./basin.js";
export type { BatchOutput, BatchTransformOptions } from "./batch-transform.js";
export type {
	AcksStream,
	AppendHeaders,
	AppendSession,
	BatchSubmitTicket,
	ReadHeaders,
	ReadSession,
	SessionTransports,
	TransportConfig,
} from "./lib/stream/types.js";

// =============================================================================
// Utilities
// =============================================================================

export type { Client } from "./generated/client/types.gen.js";
export { randomToken } from "./lib/base64.js";
export type { ListAllArgs, Page, PageFetcher } from "./lib/paginate.js";
export { paginate } from "./lib/paginate.js";
export type { Redacted } from "./lib/redacted.js";
export { meteredBytes, utf8ByteLength } from "./utils.js";
