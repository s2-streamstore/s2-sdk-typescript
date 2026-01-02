/**
 * SDK Types - CamelCase wrappers around generated API types.
 *
 * This module re-exports generated types with all keys transformed from
 * snake_case to camelCase for a more idiomatic JavaScript/TypeScript API.
 */

import type * as API from "../generated/types.gen.js";
import type { CamelCaseKeys } from "./case-transform.js";

// =============================================================================
// Access Token Types
// =============================================================================

/**
 * Access token information.
 *
 * Generated: `auto_prefix_streams`, `expires_at`
 * SDK: `autoPrefixStreams`, `expiresAt`
 */
export type AccessTokenInfo = CamelCaseKeys<API.AccessTokenInfo>;

/**
 * Access token scope.
 *
 * Generated: `access_tokens`, `op_groups`
 * SDK: `accessTokens`, `opGroups`
 */
export type AccessTokenScope = CamelCaseKeys<API.AccessTokenScope>;

// =============================================================================
// Basin Types
// =============================================================================

/**
 * Basin configuration.
 *
 * Generated: `create_stream_on_append`, `create_stream_on_read`, `default_stream_config`
 * SDK: `createStreamOnAppend`, `createStreamOnRead`, `defaultStreamConfig`
 */
export type BasinConfig = CamelCaseKeys<API.BasinConfig>;

/**
 * Basin information.
 */
export type BasinInfo = CamelCaseKeys<API.BasinInfo>;

/**
 * Basin reconfiguration options.
 *
 * Generated: `create_stream_on_append`, `create_stream_on_read`, `default_stream_config`
 * SDK: `createStreamOnAppend`, `createStreamOnRead`, `defaultStreamConfig`
 */
export type BasinReconfiguration = CamelCaseKeys<API.BasinReconfiguration>;

// =============================================================================
// Stream Types
// =============================================================================

/**
 * Stream configuration.
 *
 * Generated: `delete_on_empty`, `retention_policy`, `storage_class`
 * SDK: `deleteOnEmpty`, `retentionPolicy`, `storageClass`
 */
export type StreamConfig = CamelCaseKeys<API.StreamConfig>;

/**
 * Stream information.
 *
 * Generated: `created_at`, `deleted_at`
 * SDK: `createdAt`, `deletedAt`
 */
export type StreamInfo = CamelCaseKeys<API.StreamInfo>;

/**
 * Stream reconfiguration options.
 *
 * Generated: `delete_on_empty`, `retention_policy`, `storage_class`
 * SDK: `deleteOnEmpty`, `retentionPolicy`, `storageClass`
 */
export type StreamReconfiguration = CamelCaseKeys<API.StreamReconfiguration>;

/**
 * Delete-on-empty configuration.
 *
 * Generated: `min_age_secs`
 * SDK: `minAgeSecs`
 */
export type DeleteOnEmptyConfig = CamelCaseKeys<API.DeleteOnEmptyConfig>;

/**
 * Delete-on-empty reconfiguration.
 *
 * Generated: `min_age_secs`
 * SDK: `minAgeSecs`
 */
export type DeleteOnEmptyReconfiguration =
	CamelCaseKeys<API.DeleteOnEmptyReconfiguration>;

// =============================================================================
// List Response Types
// =============================================================================

/**
 * List access tokens response.
 *
 * Generated: `access_tokens`, `has_more`
 * SDK: `accessTokens`, `hasMore`
 */
export type ListAccessTokensResponse =
	CamelCaseKeys<API.ListAccessTokensResponse>;

/**
 * List basins response.
 *
 * Generated: `has_more`
 * SDK: `hasMore`
 */
export type ListBasinsResponse = CamelCaseKeys<API.ListBasinsResponse>;

/**
 * List streams response.
 *
 * Generated: `has_more`
 * SDK: `hasMore`
 */
export type ListStreamsResponse = CamelCaseKeys<API.ListStreamsResponse>;

// =============================================================================
// Metric Types
// =============================================================================

/**
 * Accumulation metric with bucket length.
 *
 * Generated: `bucket_length`
 * SDK: `bucketLength`
 */
export type AccumulationMetric = CamelCaseKeys<API.AccumulationMetric>;

// =============================================================================
// Other Types
// =============================================================================

/**
 * Sequenced record (read from stream).
 *
 * Generated: `seq_num`
 * SDK: `seqNum`
 */
export type SequencedRecord = CamelCaseKeys<API.SequencedRecord>;

/**
 * Timestamping configuration.
 */
export type TimestampingConfig = CamelCaseKeys<API.TimestampingConfig>;

/**
 * Timestamping reconfiguration.
 */
export type TimestampingReconfiguration =
	CamelCaseKeys<API.TimestampingReconfiguration>;

/**
 * Issue access token response.
 *
 * Generated: `access_token`
 * SDK: `accessToken`
 */
export type IssueAccessTokenResponse =
	CamelCaseKeys<API.IssueAccessTokenResponse>;

// =============================================================================
// Re-export types that don't need transformation (already camelCase or simple)
// =============================================================================

export type {
	AccessTokenIdStr,
	AccountMetricSet,
	BasinMetricSet,
	BasinScope,
	BasinState,
	CreateStreamRequest,
	FencingToken,
	GaugeMetric,
	Header,
	InfiniteRetention,
	LabelMetric,
	Metric,
	MetricSetResponse,
	MetricUnit,
	Operation,
	PermittedOperationGroups,
	ReadWritePermissions,
	ResourceSet,
	RetentionPolicy,
	ScalarMetric,
	StorageClass,
	StreamMetricSet,
	TimeseriesInterval,
	TimestampingMode,
} from "../generated/types.gen.js";
