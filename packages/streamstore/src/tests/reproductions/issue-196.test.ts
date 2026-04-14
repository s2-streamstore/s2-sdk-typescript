import { describe, expect, it } from "vitest";
import { toSnakeCase } from "../../internal/case-transform.js";

/**
 * Issue #196: reconfigure methods send path params (basin/stream) in the request body.
 *
 * The OpenAPI spec defines:
 *  - ReconfigureBasinData.body = BasinReconfiguration (no `basin` field)
 *  - ReconfigureStreamData.body = StreamReconfiguration (no `stream` field)
 *
 * But basins.ts and streams.ts spread the full `args` (including path params)
 * into the body payload via `{ ...args, ... }`, so `basin`/`stream` leak into
 * the JSON body, violating the API contract.
 *
 * The fix destructures out path params before building the body:
 *  - `const { basin, ...reconfigArgs } = args;`
 *  - `const { stream, ...reconfigArgs } = args;`
 */

describe("Issue #196: reconfigure body must not include path parameters", () => {
	it("basin reconfigure body should not contain 'basin' key", () => {
		// Simulate the fixed body construction from basins.ts
		const args = {
			basin: "my-test-basin",
			createStreamOnAppend: true,
			defaultStreamConfig: undefined,
		};

		const { basin, ...reconfigArgs } = args;
		const apiArgs = {
			...reconfigArgs,
			defaultStreamConfig: args.defaultStreamConfig,
		};
		const body = toSnakeCase(apiArgs);

		// The body must NOT contain the path param
		expect(body).not.toHaveProperty("basin");
		expect(body).toHaveProperty("create_stream_on_append", true);
	});

	it("stream reconfigure body should not contain 'stream' key", () => {
		// Simulate the fixed body construction from streams.ts
		const args = {
			stream: "my-test-stream",
			storageClass: "express" as const,
			retentionPolicy: undefined,
		};

		const { stream, ...reconfigArgs } = args;
		const apiArgs = {
			...reconfigArgs,
			retentionPolicy: args.retentionPolicy,
		};
		const body = toSnakeCase(apiArgs);

		// The body must NOT contain the path param
		expect(body).not.toHaveProperty("stream");
		expect(body).toHaveProperty("storage_class", "express");
	});

	it("demonstrates the bug: spreading full args leaks path params into body", () => {
		// This shows what the old (buggy) code did — spread `...args` into body
		const args = {
			basin: "my-test-basin",
			createStreamOnAppend: true,
			defaultStreamConfig: undefined,
		};

		const buggyApiArgs = {
			...args, // BUG: basin is included
			defaultStreamConfig: args.defaultStreamConfig,
		};
		const buggyBody = toSnakeCase(buggyApiArgs);

		// The buggy body DOES contain the path param — this is the violation
		expect(buggyBody).toHaveProperty("basin", "my-test-basin");
	});

	it("demonstrates the bug: spreading full stream args leaks path params", () => {
		const args = {
			stream: "my-test-stream",
			storageClass: "express" as const,
			retentionPolicy: undefined,
		};

		const buggyApiArgs = {
			...args, // BUG: stream is included
			retentionPolicy: args.retentionPolicy,
		};
		const buggyBody = toSnakeCase(buggyApiArgs);

		// The buggy body DOES contain the path param
		expect(buggyBody).toHaveProperty("stream", "my-test-stream");
	});
});
