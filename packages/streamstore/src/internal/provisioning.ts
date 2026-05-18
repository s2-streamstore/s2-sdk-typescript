import { S2Error, withS2Error } from "../error.js";
import type { ProvisionResult } from "../types.js";

const PROVISION_RESULT_HEADER = "s2-provision-result";

type ResponseLike = {
	status?: number;
	statusText?: string;
	headers?: {
		get(name: string): string | null;
	};
};

type GeneratedResponse<T> =
	| {
			data?: T;
			error?: unknown;
			response?: ResponseLike;
	  }
	| T;

export function provisionResultFromResponse(
	response: ResponseLike | undefined,
): ProvisionResult {
	const value = response?.headers?.get(PROVISION_RESULT_HEADER);
	if (value === "created" || value === "updated" || value === "noop") {
		return value;
	}
	return response?.status === 201 ? "created" : "updated";
}

export async function withS2DataAndResponse<T>(
	fn: () => Promise<GeneratedResponse<T>>,
): Promise<{ data: T; response?: ResponseLike }> {
	const result = (await withS2Error(fn)) as GeneratedResponse<T>;
	if (
		result &&
		typeof result === "object" &&
		(Object.prototype.hasOwnProperty.call(result, "data") ||
			Object.prototype.hasOwnProperty.call(result, "response") ||
			Object.prototype.hasOwnProperty.call(result, "error"))
	) {
		const response = (result as { response?: ResponseLike }).response;
		const data = (result as { data?: T }).data;
		if (typeof data !== "undefined") {
			return { data, response };
		}
		throw new S2Error({
			message: "Empty response",
			status: response?.status ?? 500,
			origin: "server",
		});
	}
	return { data: result as T };
}
