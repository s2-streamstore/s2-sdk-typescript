import { S2Error, type S2Stream } from "@s2-dev/streamstore";
import {
	appendFenceCommand,
	appendTrimCommand,
	isFenceRecord,
	isTerminalFence,
	isTrimRecord,
} from "./protocol.js";

interface SharedStreamState {
	reusableFenceToken: string | null;
	/**
	 * Token of the current holder when there is an active generation. Used
	 * to promote to the reusable slot after the lease expires.
	 */
	heldFenceToken: string | null;
	activeGenerationStartSeqNum: number | null;
	hasActiveGeneration: boolean;
	nextSeqNum: number;
	/**
	 * Unix-ms timestamp of the most recent record of any kind, or null if the
	 * stream is empty. Used as the liveness signal for the lease check: as
	 * long as the generation keeps writing records, the lease keeps sliding
	 * forward.
	 */
	lastRecordTimestamp: number | null;
}

function createEmptySharedStreamState(): SharedStreamState {
	return {
		reusableFenceToken: "",
		heldFenceToken: null,
		activeGenerationStartSeqNum: null,
		hasActiveGeneration: false,
		nextSeqNum: 0,
		lastRecordTimestamp: null,
	};
}

function isMissingStreamError(error: unknown): boolean {
	return (
		error instanceof S2Error &&
		error.status === 404 &&
		(error.code === "stream_not_found" || error.code === undefined)
	);
}

async function readSharedStreamState(
	stream: S2Stream,
): Promise<SharedStreamState> {
	const session = await stream
		.readSession(
			{
				start: { from: { seqNum: 0 }, clamp: true },
				stop: { waitSecs: 0 },
			},
			{ as: "string" },
		)
		.catch((error: unknown) => {
			if (isMissingStreamError(error)) return null;
			throw error;
		});
	if (!session) return createEmptySharedStreamState();

	const state = createEmptySharedStreamState();
	try {
		for await (const record of session) {
			state.nextSeqNum = record.seqNum + 1;
			state.lastRecordTimestamp = record.timestamp.getTime();
			if (!isFenceRecord(record)) {
				continue;
			}
			if (isTerminalFence(record)) {
				state.hasActiveGeneration = false;
				state.reusableFenceToken = record.body;
				continue;
			}
			state.activeGenerationStartSeqNum = record.seqNum;
			state.hasActiveGeneration = true;
			// Remember the current holder's token so it can be promoted to the
			// reusable slot once its lease expires.
			state.reusableFenceToken = null;
			state.heldFenceToken = record.body;
		}
	} finally {
		await session[Symbol.asyncDispose]?.();
	}
	return state;
}

export async function claimSharedGeneration({
	stream,
	fencingToken,
	leaseDurationMs,
	now = () => Date.now(),
	trim = true,
}: {
	stream: S2Stream;
	fencingToken: string;
	leaseDurationMs: number;
	/** Time source override for tests. */
	now?: () => number;
	/**
	 * Trim records before the new fence after claiming. `true` for one-shot
	 * generations (`createResumableGeneration` `shared` mode). `false` for
	 * session logs that need to preserve history across generations.
	 *
	 * @default true
	 */
	trim?: boolean;
}): Promise<{
	fromSeqNum: number;
	matchSeqNumStart: number;
} | null> {
	const state = await readSharedStreamState(stream);

	let currentToken = state.reusableFenceToken;
	if (
		currentToken === null &&
		state.heldFenceToken !== null &&
		state.lastRecordTimestamp !== null &&
		now() - state.lastRecordTimestamp >= leaseDurationMs
	) {
		// Active generation hasn't written anything for at least
		// leaseDurationMs, so treat it as abandoned and take it over.
		currentToken = state.heldFenceToken;
	}

	if (currentToken === null) {
		return null;
	}

	const fenceAck = await appendFenceCommand(stream, currentToken, fencingToken);
	let matchSeqNumStart = fenceAck.end.seqNum;

	if (trim && state.nextSeqNum > 0) {
		const trimAck = await appendTrimCommand(
			stream,
			fencingToken,
			fenceAck.start.seqNum,
		);
		matchSeqNumStart = trimAck.end.seqNum;
	}

	return {
		fromSeqNum: fenceAck.start.seqNum,
		matchSeqNumStart,
	};
}

export async function* replayActiveGenerationStringBodies(
	stream: S2Stream,
): AsyncIterable<string> {
	const state = await readSharedStreamState(stream);
	if (state.activeGenerationStartSeqNum === null) return;
	if (!state.hasActiveGeneration) return;

	const session = await stream.readSession(
		{
			start: { from: { seqNum: state.activeGenerationStartSeqNum } },
		},
		{ as: "string" },
	);
	try {
		for await (const record of session) {
			if (isFenceRecord(record)) {
				if (isTerminalFence(record)) break;
				continue;
			}
			if (isTrimRecord(record)) continue;
			if (record.body) {
				yield record.body;
			}
		}
	} finally {
		await session[Symbol.asyncDispose]?.();
	}
}
