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

// =============================================================================
// Stream Types
// =============================================================================

/**
 * Stream information.
 *
 * Generated: `created_at`, `deleted_at`, `cipher`
 * SDK: `createdAt`, `deletedAt`, `cipher`
 */
export type StreamInfo = CamelCaseKeys<API.StreamInfo>;

// =============================================================================
// List Response Types
// =============================================================================

/**
 * List basins response.
 *
 * Generated: `has_more`
 * SDK: `hasMore`
 */
export type ListBasinsResponse = CamelCaseKeys<API.ListBasinsResponse>;

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
