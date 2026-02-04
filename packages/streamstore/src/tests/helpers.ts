import type { S2 } from "../index.js";

export const TEST_TIMEOUT_MS = 120_000;

export const sleep = (ms: number) =>
	new Promise((resolve) => setTimeout(resolve, ms));

export const makeBasinName = (prefix: string): string => {
	const suffix = Math.random().toString(36).slice(2, 10);
	return `${prefix}-${suffix}`.slice(0, 48);
};

export const makeStreamName = (prefix: string): string =>
	`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const isFreeTierLimitation = (err: unknown): boolean => {
	const message =
		err && typeof err === "object" && "message" in err
			? String((err as { message?: unknown }).message)
			: "";
	return message.toLowerCase().includes("free tier");
};

export const waitForBasinReady = async (
	s2: S2,
	basin: string,
	deadlineMs = 60_000,
): Promise<void> => {
	const start = Date.now();
	while (Date.now() - start < deadlineMs) {
		try {
			await s2.basins.getConfig({ basin });
			return;
		} catch (err) {
			const status =
				err && typeof err === "object" && "status" in err
					? (err as { status?: number }).status
					: undefined;
			if (status === 503) {
				await sleep(500);
				continue;
			}
			throw err;
		}
	}
	throw new Error(`Timed out waiting for basin ${basin} to become active`);
};
