/**
 * S2 SDK Types
 *
 * All public SDK types are defined here. Types use camelCase field names
 * for idiomatic JavaScript/TypeScript usage.
 *
 * Generated types (snake_case, matching API wire format) are available
 * from "./generated/types.gen.js" as the `API` namespace.
 */

import { S2Error } from "./error.js";
import type * as API from "./generated/types.gen.js";
import type { ListAllArgs } from "./lib/paginate.js";
import { meteredBytes as calculateMeteredBytes } from "./utils.js";

// =============================================================================
// Stream Position
// =============================================================================

/**
 * Position of a record in a stream.
 */
export interface StreamPosition {
	/** Sequence number assigned by the service. */
	readonly seqNum: number;
	/** Timestamp of the record. */
	readonly timestamp: Date;
}

// =============================================================================
// Append Record Types
// =============================================================================

/**
 * Append record with string body and string headers.
 * Use `AppendRecord.string()` to construct instances.
 */
export interface StringAppendRecord {
	readonly body: string;
	readonly headers?: ReadonlyArray<readonly [string, string]>;
	/** Optional timestamp (Date or milliseconds since Unix epoch). */
	readonly timestamp?: number | Date;
	/** Pre-calculated metered size in bytes. */
	readonly meteredBytes: number;
}

/**
 * Append record with binary body and binary headers.
 * Use `AppendRecord.bytes()` to construct instances.
 */
export interface BytesAppendRecord {
	readonly body: Uint8Array;
	readonly headers?: ReadonlyArray<readonly [Uint8Array, Uint8Array]>;
	/** Optional timestamp (Date or milliseconds since Unix epoch). */
	readonly timestamp?: number | Date;
	/** Pre-calculated metered size in bytes. */
	readonly meteredBytes: number;
}

/**
 * Record to be appended to a stream.
 * Can be either string format (text) or bytes format (binary).
 */
export type AppendRecord = StringAppendRecord | BytesAppendRecord;

const textEncoder = new TextEncoder();

/**
 * Factory functions for creating AppendRecord instances.
 */
export namespace AppendRecord {
	/**
	 * Create a string-format append record with pre-calculated metered size.
	 */
	export function string(params: {
		readonly body: string;
		readonly headers?: ReadonlyArray<readonly [string, string]>;
		readonly timestamp?: number | Date;
	}): StringAppendRecord {
		// Create record with placeholder, then calculate actual size
		const record: StringAppendRecord = {
			body: params.body,
			headers: params.headers,
			timestamp: params.timestamp,
			meteredBytes: 0,
		};
		// Safe to cast: we're setting a readonly property during construction
		(record as { meteredBytes: number }).meteredBytes =
			calculateMeteredBytes(record);
		return record;
	}

	/**
	 * Create a bytes-format append record with pre-calculated metered size.
	 */
	export function bytes(params: {
		readonly body: Uint8Array;
		readonly headers?: ReadonlyArray<readonly [Uint8Array, Uint8Array]>;
		readonly timestamp?: number | Date;
	}): BytesAppendRecord {
		// Create record with placeholder, then calculate actual size
		const record: BytesAppendRecord = {
			body: params.body,
			headers: params.headers,
			timestamp: params.timestamp,
			meteredBytes: 0,
		};
		// Safe to cast: we're setting a readonly property during construction
		(record as { meteredBytes: number }).meteredBytes =
			calculateMeteredBytes(record);
		return record;
	}

	/**
	 * Create a fence command record.
	 */
	export function fence(
		fencingToken: string,
		timestamp?: number | Date,
	): StringAppendRecord {
		return string({
			body: fencingToken,
			headers: [["", "fence"]],
			timestamp,
		});
	}

	/**
	 * Create a trim command record.
	 */
	export function trim(
		seqNum: number,
		timestamp?: number | Date,
	): BytesAppendRecord {
		const buffer = new Uint8Array(8);
		const view = new DataView(buffer.buffer);
		view.setBigUint64(0, BigInt(seqNum), false);

		return bytes({
			body: buffer,
			headers: [[textEncoder.encode(""), textEncoder.encode("trim")]],
			timestamp,
		});
	}
}

// =============================================================================
// Read Record Types
// =============================================================================

/**
 * Record read from a stream.
 * The Format type parameter controls whether body and headers are decoded as strings or kept as binary.
 */
export interface ReadRecord<Format extends "string" | "bytes" = "string"> {
	readonly seqNum: number;
	readonly body: Format extends "string" ? string : Uint8Array;
	readonly headers: Format extends "string"
		? ReadonlyArray<readonly [string, string]>
		: ReadonlyArray<readonly [Uint8Array, Uint8Array]>;
	/** Timestamp of the record. */
	readonly timestamp: Date;
}

// =============================================================================
// Append Input
// =============================================================================

/** Maximum number of records in a single append batch. */
export const MAX_APPEND_RECORDS = 1000;

/** Maximum total metered bytes for records in a single append batch (1 MiB). */
export const MAX_APPEND_BYTES = 1024 * 1024;

/**
 * Input for append operations.
 * Use `AppendInput.create()` to construct with validation.
 */
export interface AppendInput {
	readonly records: ReadonlyArray<AppendRecord>;
	readonly matchSeqNum?: number;
	readonly fencingToken?: string;
	/** Pre-calculated total metered size in bytes. */
	readonly meteredBytes: number;
}

/**
 * Factory functions for creating AppendInput instances.
 */
export namespace AppendInput {
	/**
	 * Create an AppendInput with validation.
	 *
	 * @throws {S2Error} If validation fails (empty, too many records, or too large)
	 */
	export function create(
		records: ReadonlyArray<AppendRecord>,
		options?: {
			readonly matchSeqNum?: number;
			readonly fencingToken?: string;
		},
	): AppendInput {
		if (records.length === 0) {
			throw new S2Error({
				message: "AppendInput must contain at least one record",
				origin: "sdk",
			});
		}

		if (records.length > MAX_APPEND_RECORDS) {
			throw new S2Error({
				message: `AppendInput cannot contain more than ${MAX_APPEND_RECORDS} records (got ${records.length})`,
				origin: "sdk",
			});
		}

		const totalBytes = records.reduce((sum, r) => sum + r.meteredBytes, 0);
		if (totalBytes > MAX_APPEND_BYTES) {
			throw new S2Error({
				message: `AppendInput exceeds maximum of ${MAX_APPEND_BYTES} bytes (got ${totalBytes} bytes)`,
				origin: "sdk",
			});
		}

		return {
			records,
			matchSeqNum: options?.matchSeqNum,
			fencingToken: options?.fencingToken,
			meteredBytes: totalBytes,
		};
	}
}

// =============================================================================
// Read Input
// =============================================================================

/**
 * Starting position for reading from a stream.
 */
export type ReadFrom =
	| { readonly seqNum: number }
	| { readonly timestamp: number | Date }
	| { readonly tailOffset: number };

/**
 * Where to start reading.
 */
export interface ReadStart {
	readonly from?: ReadFrom;
	/** Start from tail if requested position is beyond it. */
	readonly clamp?: boolean;
}

/**
 * Limits on how much to read.
 */
export interface ReadLimits {
	readonly count?: number;
	readonly bytes?: number;
}

/**
 * When to stop reading.
 */
export interface ReadStop {
	readonly limits?: ReadLimits;
	/** Timestamp at which to stop (exclusive, milliseconds since epoch). */
	readonly until?: number;
	/** Duration in seconds to wait for new records before stopping. */
	readonly wait?: number;
}

/**
 * Input for read operations.
 */
export interface ReadInput {
	readonly start?: ReadStart;
	readonly stop?: ReadStop;
	readonly ignoreCommandRecords?: boolean;
}

// =============================================================================
// Response Types
// =============================================================================

/**
 * Success response to an append request.
 */
export interface AppendAck {
	readonly start: StreamPosition;
	readonly end: StreamPosition;
	readonly tail: StreamPosition;
}

/**
 * Batch of records read from a stream.
 */
export interface ReadBatch<Format extends "string" | "bytes" = "string"> {
	readonly records: ReadonlyArray<ReadRecord<Format>>;
	readonly tail?: StreamPosition;
}

/**
 * Response from checking the tail of a stream.
 */
export interface TailResponse {
	readonly tail: StreamPosition;
}

// =============================================================================
// Session Options
// =============================================================================

/**
 * Options for append sessions (backpressure control).
 */
export interface AppendSessionOptions {
	/** Max in-flight bytes before backpressure (default: 10 MiB). */
	readonly maxInflightBytes?: number;
	/** Max in-flight batches before backpressure. */
	readonly maxInflightBatches?: number;
}

// =============================================================================
// Stream Types
// =============================================================================

// Stream input types (explicit interfaces for documentation)

/**
 * Input for listing streams.
 */
export interface ListStreamsInput {
	/** Filter to streams whose name begins with this prefix. */
	prefix?: string;
	/** Filter to streams whose name lexicographically starts after this string. */
	startAfter?: string;
	/** Number of results, up to a maximum of 1000. */
	limit?: number;
}

export type ListAllStreamsInput = ListAllArgs<ListStreamsInput>;

/**
 * Input for creating a stream.
 */
export interface CreateStreamInput {
	/**
	 * Stream name that is unique to the basin.
	 * It can be between 1 and 512 bytes in length.
	 */
	stream: string;
	/** Stream configuration. */
	config?: StreamConfig | null;
}

/**
 * Input for getting stream configuration.
 */
export interface GetStreamConfigInput {
	/** Stream name. */
	stream: string;
}

/**
 * Input for deleting a stream.
 */
export interface DeleteStreamInput {
	/** Stream name. */
	stream: string;
}

/**
 * Input for reconfiguring a stream.
 */
export interface ReconfigureStreamInput {
	/** Stream name. */
	stream: string;
	/** Delete-on-empty configuration. */
	deleteOnEmpty?: DeleteOnEmptyConfig | null;
	/** Retention policy. */
	retentionPolicy?: RetentionPolicy | null;
	/** Storage class. */
	storageClass?: API.StorageClass | null;
	/** Timestamping configuration. */
	timestamping?: TimestampingConfig | null;
}

// Stream response types (explicit interfaces for documentation)

/**
 * Information about a stream.
 */
export interface StreamInfo {
	/** Stream name. */
	name: string;
	/** Creation time in ISO 8601 format. */
	createdAt: string;
	/** Deletion time in ISO 8601 format, if the stream is being deleted. */
	deletedAt?: string | null;
}

/**
 * Delete-on-empty configuration.
 */
export interface DeleteOnEmptyConfig {
	/**
	 * Minimum age in seconds before an empty stream can be deleted.
	 * Set to 0 (default) to disable delete-on-empty.
	 */
	minAgeSecs?: number;
}

/**
 * Timestamping configuration.
 */
export interface TimestampingConfig {
	/** Timestamping mode. */
	mode?: API.TimestampingMode | null;
	/**
	 * Allow client-specified timestamps to exceed the arrival time.
	 * If false or not set, client timestamps will be capped at the arrival time.
	 */
	uncapped?: boolean | null;
}

/**
 * Retention policy for automatic trimming.
 *
 * Either specify `ageSecs` for time-based retention, or `infinite` for unlimited retention.
 */
export type RetentionPolicy =
	| {
			/** Age in seconds for automatic trimming of records older than this threshold. Must be > 0. */
			ageSecs: number;
	  }
	| {
			/** Retain records unless explicitly trimmed. */
			infinite: API.InfiniteRetention;
	  };

/**
 * Stream configuration.
 */
export interface StreamConfig {
	/** Delete-on-empty configuration. */
	deleteOnEmpty?: DeleteOnEmptyConfig | null;
	/** Retention policy. */
	retentionPolicy?: RetentionPolicy | null;
	/** Storage class. */
	storageClass?: API.StorageClass | null;
	/** Timestamping configuration. */
	timestamping?: TimestampingConfig | null;
}

/**
 * Response from listing streams.
 */
export interface ListStreamsResponse {
	/** List of streams. */
	streams: StreamInfo[];
	/** Whether there are more results. */
	hasMore: boolean;
}

/**
 * Response from creating a stream.
 */
export interface CreateStreamResponse {
	/** Stream configuration. */
	config: StreamConfig;
}

export type ReconfigureStreamResponse = StreamConfig;

// =============================================================================
// Basin Types
// =============================================================================

// Basin input types (explicit interfaces for documentation)

/**
 * Input for listing basins.
 */
export interface ListBasinsInput {
	/** Filter to basins whose names begin with this prefix. */
	prefix?: string;
	/** Filter to basins whose names lexicographically start after this string. */
	startAfter?: string;
	/** Number of results, up to a maximum of 1000. */
	limit?: number;
}

export type ListAllBasinsInput = ListAllArgs<ListBasinsInput>;

/**
 * Input for creating a basin.
 */
export interface CreateBasinInput {
	/**
	 * Basin name which must be globally unique.
	 * It can be between 8 and 48 characters in length, and comprise lowercase letters, numbers and hyphens.
	 * It cannot begin or end with a hyphen.
	 */
	basin: string;
	/** Basin configuration. */
	config?: BasinConfig | null;
	/** Basin scope. */
	scope?: API.BasinScope;
}

/**
 * Input for getting basin configuration.
 */
export interface GetBasinConfigInput {
	/** Basin name. */
	basin: string;
}

/**
 * Input for deleting a basin.
 */
export interface DeleteBasinInput {
	/** Basin name. */
	basin: string;
}

/**
 * Input for reconfiguring a basin.
 */
export interface ReconfigureBasinInput {
	/** Basin name. */
	basin: string;
	/** Create a stream on append. */
	createStreamOnAppend?: boolean | null;
	/** Create a stream on read. */
	createStreamOnRead?: boolean | null;
	/** Default stream configuration updates. */
	defaultStreamConfig?: StreamConfig | null;
}

// Basin response types (explicit interfaces for documentation)

/**
 * Information about a basin.
 */
export interface BasinInfo {
	/** Basin name. */
	name: string;
	/** Basin scope. */
	scope: API.BasinScope;
	/** Basin state. */
	state: API.BasinState;
}

/**
 * Basin configuration.
 */
export interface BasinConfig {
	/** Create stream on append if it doesn't exist. */
	createStreamOnAppend?: boolean;
	/** Create stream on read if it doesn't exist. */
	createStreamOnRead?: boolean;
	/** Default stream configuration. */
	defaultStreamConfig?: StreamConfig | null;
}

/**
 * Response from listing basins.
 */
export interface ListBasinsResponse {
	/** List of basins. */
	basins: BasinInfo[];
	/** Whether there are more results. */
	hasMore: boolean;
}

/**
 * Response from creating a basin.
 */
export interface CreateBasinResponse {
	/** Basin name. */
	name: string;
	/** Basin scope. */
	scope: API.BasinScope;
	/** Basin state. */
	state: API.BasinState;
}

export type ReconfigureBasinResponse = BasinConfig;

// =============================================================================
// Access Token Types
// =============================================================================

// Access token input types (explicit interfaces for documentation)

/**
 * Input for listing access tokens.
 */
export interface ListAccessTokensInput {
	/** Filter to access tokens whose ID begins with this prefix. */
	prefix?: string;
	/** Filter to access tokens whose ID lexicographically starts after this string. */
	startAfter?: string;
	/** Number of results, up to a maximum of 1000. */
	limit?: number;
}

export type ListAllAccessTokensInput = ListAllArgs<ListAccessTokensInput>;

/**
 * Scope for an access token.
 */
export interface AccessTokenScope {
	/** Resource set for access tokens. */
	accessTokens?: API.ResourceSet | null;
	/** Resource set for basins. */
	basins?: API.ResourceSet | null;
	/** Permitted operation groups. */
	opGroups?: API.PermittedOperationGroups | null;
	/** Operations allowed for the token. */
	ops?: API.Operation[] | null;
	/** Resource set for streams. */
	streams?: API.ResourceSet | null;
}

/**
 * Input for issuing an access token.
 */
export interface IssueAccessTokenInput {
	/**
	 * Access token ID.
	 * It must be unique to the account and between 1 and 96 bytes in length.
	 */
	id: string;
	/** Access token scope. */
	scope: AccessTokenScope;
	/**
	 * Namespace streams based on the configured stream-level scope, which must be a prefix.
	 * Stream name arguments will be automatically prefixed, and the prefix will be stripped when listing streams.
	 */
	autoPrefixStreams?: boolean;
	/**
	 * Expiration time (Date or ISO 8601 string).
	 * If not set, the expiration will be set to that of the requestor's token.
	 */
	expiresAt?: Date | string | null;
}

/**
 * Input for revoking an access token.
 */
export interface RevokeAccessTokenInput {
	/** Access token ID. */
	id: string;
}

// Access token response types (explicit interfaces for documentation)

/**
 * Information about an access token.
 */
export interface AccessTokenInfo {
	/** Access token ID. */
	id: string;
	/** Access token scope. */
	scope: AccessTokenScope;
	/** Whether streams are auto-prefixed. */
	autoPrefixStreams?: boolean;
	/** Expiration time. */
	expiresAt?: Date | null;
}

/**
 * Response from listing access tokens.
 */
export interface ListAccessTokensResponse {
	/** List of access tokens. */
	accessTokens: AccessTokenInfo[];
	/** Whether there are more results. */
	hasMore: boolean;
}

/**
 * Response from issuing an access token.
 */
export interface IssueAccessTokenResponse {
	/** The created access token. */
	accessToken: string;
}

// =============================================================================
// Metrics Types
// =============================================================================

// Metrics input types (explicit interfaces for documentation)

/**
 * Input for account-level metrics.
 */
export interface AccountMetricsInput {
	/** Metric set to return. */
	set: API.AccountMetricSet;
	/** Start timestamp (Date, or milliseconds since Unix epoch), if applicable for the metric set. */
	start?: number | Date;
	/** End timestamp (Date, or milliseconds since Unix epoch), if applicable for the metric set. */
	end?: number | Date;
	/** Interval to aggregate over for timeseries metric sets. */
	interval?: API.TimeseriesInterval;
}

/**
 * Input for basin-level metrics.
 */
export interface BasinMetricsInput {
	/** Basin name. */
	basin: string;
	/** Metric set to return. */
	set: API.BasinMetricSet;
	/** Start timestamp (Date, or milliseconds since Unix epoch), if applicable for the metric set. */
	start?: number | Date;
	/** End timestamp (Date, or milliseconds since Unix epoch), if applicable for the metric set. */
	end?: number | Date;
	/** Interval to aggregate over for timeseries metric sets. */
	interval?: API.TimeseriesInterval;
}

/**
 * Input for stream-level metrics.
 */
export interface StreamMetricsInput {
	/** Basin name. */
	basin: string;
	/** Stream name. */
	stream: string;
	/** Metric set to return. */
	set: API.StreamMetricSet;
	/** Start timestamp (Date, or milliseconds since Unix epoch), if applicable for the metric set. */
	start?: number | Date;
	/** End timestamp (Date, or milliseconds since Unix epoch), if applicable for the metric set. */
	end?: number | Date;
	/** Interval to aggregate over for timeseries metric sets. */
	interval?: API.TimeseriesInterval;
}

// =============================================================================
// Metrics Response Types
// =============================================================================

/**
 * A scalar metric with a single value.
 */
export interface ScalarMetric {
	/** Metric name. */
	name: string;
	/** Unit of the metric. */
	unit: API.MetricUnit;
	/** Metric value. */
	value: number;
}

/**
 * An accumulation metric with timeseries values aggregated over a bucket.
 */
export interface AccumulationMetric {
	/** The duration of bucket for the accumulation. */
	bucketLength: API.TimeseriesInterval;
	/** Timeseries name. */
	name: string;
	/** Unit of the metric. */
	unit: API.MetricUnit;
	/**
	 * Timeseries values.
	 * Each element is a pair `[timestamp, value]`.
	 */
	values: Array<[Date, number]>;
}

/**
 * A gauge metric with instantaneous values at timestamps.
 */
export interface GaugeMetric {
	/** Timeseries name. */
	name: string;
	/** Unit of the metric. */
	unit: API.MetricUnit;
	/**
	 * Timeseries values.
	 * Each element is a pair `[timestamp, value]`.
	 * The value represents the measurement at the instant of the timestamp.
	 */
	values: Array<[Date, number]>;
}

/**
 * A label metric with string values.
 */
export interface LabelMetric {
	/** Label name. */
	name: string;
	/** Label values. */
	values: Array<string>;
}

/**
 * A metric in a metric set response.
 * Can be a scalar, accumulation, gauge, or label metric.
 */
export type Metric =
	| { scalar: ScalarMetric }
	| { accumulation: AccumulationMetric }
	| { gauge: GaugeMetric }
	| { label: LabelMetric };

/**
 * Response from a metrics query.
 */
export interface MetricSetResponse {
	/** Metrics comprising the set. */
	values: Array<Metric>;
}
