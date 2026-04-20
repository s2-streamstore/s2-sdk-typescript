import { S2Error } from "@s2-dev/streamstore";
import {
	appendFenceCommand,
	appendTrimCommand,
	isFenceRecord,
	isTerminalFence,
	isTrimRecord,
	type StreamReadOptions,
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
	/** Unix-ms timestamp of the most recent fence record, or null if none. */
	lastFenceTimestamp: number | null;
}

function createEmptySharedStreamState(): SharedStreamState {
	return {
		reusableFenceToken: "",
		heldFenceToken: null,
		activeGenerationStartSeqNum: null,
		hasActiveGeneration: false,
		nextSeqNum: 0,
		lastFenceTimestamp: null,
	};
}

function isMissingStreamError(error: unknown): boolean {
	return (
		error instanceof S2Error &&
		error.status === 404 &&
		(error.code === "stream_not_found" || error.code === undefined)
	);
}

async function readSharedStreamState({
	s2,
	basin,
	stream,
}: StreamReadOptions): Promise<SharedStreamState> {
	const handle = s2.basin(basin).stream(stream);
	try {
		const session = await handle
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
		for await (const record of session) {
			state.nextSeqNum = record.seqNum + 1;
			if (!isFenceRecord(record)) {
				continue;
			}
			state.lastFenceTimestamp = record.timestamp.getTime();
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
		return state;
	} finally {
		await handle.close();
	}
}

export async function claimSharedGeneration({
	s2,
	basin,
	stream,
	fencingToken,
	leaseDurationMs,
	now = () => Date.now(),
}: StreamReadOptions & {
	fencingToken: string;
	leaseDurationMs: number;
	/** Time source override for tests. */
	now?: () => number;
}): Promise<{
	fromSeqNum: number;
	matchSeqNumStart: number;
} | null> {
	const state = await readSharedStreamState({ s2, basin, stream });

	let currentToken = state.reusableFenceToken;
	if (
		currentToken === null &&
		state.heldFenceToken !== null &&
		state.lastFenceTimestamp !== null &&
		now() - state.lastFenceTimestamp >= leaseDurationMs
	) {
		// Previous generation abandoned without writing a terminal fence and
		// its lease has expired; take it over.
		currentToken = state.heldFenceToken;
	}

	if (currentToken === null) {
		return null;
	}

	const fenceAck = await appendFenceCommand(
		s2,
		basin,
		stream,
		currentToken,
		fencingToken,
	);
	let matchSeqNumStart = fenceAck.end.seqNum;

	if (state.nextSeqNum > 0) {
		const trimAck = await appendTrimCommand(
			s2,
			basin,
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

export async function* replayActiveGenerationStringBodies({
	s2,
	basin,
	stream,
}: StreamReadOptions): AsyncIterable<string> {
	const state = await readSharedStreamState({ s2, basin, stream });
	if (state.activeGenerationStartSeqNum === null) return;
	if (!state.hasActiveGeneration) return;

	const handle = s2.basin(basin).stream(stream);
	try {
		const session = await handle.readSession(
			{
				start: { from: { seqNum: state.activeGenerationStartSeqNum } },
			},
			{ as: "string" },
		);
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
		await handle.close();
	}
}
