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
// SDK Types (Hot Paths)
// =============================================================================

export type {
	AppendAck,
	AppendSessionOptions,
	BytesAppendRecord,
	ReadBatch,
	ReadFrom,
	ReadInput,
	ReadLimits,
	ReadRecord,
	ReadStart,
	ReadStop,
	StreamPosition,
	StringAppendRecord,
	TailResponse,
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
// Generated Types (Re-exported directly)
// =============================================================================

/**
 * Generated API types for configs, info, and metrics.
 * These use snake_case field names matching the wire format.
 */
export type {
	// Access token types
	AccessTokenIdStr,
	AccessTokenInfo,
	AccessTokenScope,
	AccountMetricSet,
	AccumulationMetric,
	// Config types
	BasinConfig,
	// Info types
	BasinInfo,
	BasinMetricSet,
	BasinReconfiguration,
	BasinScope,
	BasinState,
	CreateStreamRequest,
	DeleteOnEmptyConfig,
	DeleteOnEmptyReconfiguration,
	// Other generated types
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
	// Metric types
	MetricSetResponse,
	MetricUnit,
	Operation,
	PermittedOperationGroups,
	ReadWritePermissions,
	ResourceSet,
	RetentionPolicy,
	ScalarMetric,
	SequencedRecord,
	StorageClass,
	StreamConfig,
	StreamInfo,
	StreamMetricSet,
	StreamReconfiguration,
	TimeseriesInterval,
	TimestampingConfig,
	TimestampingMode,
	TimestampingReconfiguration,
} from "./generated/types.gen.js";

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
// Input Types (Management Operations)
// =============================================================================

export type {
	IssueAccessTokenInput,
	ListAccessTokensInput,
	ListAllAccessTokensInput,
	RevokeAccessTokenInput,
} from "./accessTokens.js";
export type { StreamOptions } from "./basin.js";
export type {
	CreateBasinInput,
	DeleteBasinInput,
	GetBasinConfigInput,
	ListAllBasinsInput,
	ListBasinsInput,
	ReconfigureBasinInput,
} from "./basins.js";
export type { BatchOutput, BatchTransformOptions } from "./batch-transform.js";
export type {
	AccountMetricsInput,
	BasinMetricsInput,
	StreamMetricsInput,
} from "./metrics.js";
export type {
	CreateStreamInput,
	DeleteStreamInput,
	GetStreamConfigInput,
	ListAllStreamsInput,
	ListStreamsInput,
	ReconfigureStreamInput,
} from "./streams.js";

// =============================================================================
// Streaming Types
// =============================================================================

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
