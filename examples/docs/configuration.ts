/**
 * Documentation examples for Configuration page.
 * These snippets are extracted by the docs build script.
 *
 * Run with: npx tsx examples/docs/configuration.ts
 * Requires: S2_ACCESS_TOKEN environment variable
 */

import { S2 } from "@s2-dev/streamstore";

// Each snippet is wrapped in a block scope to allow independent `client` declarations
{
	// ANCHOR: custom-endpoints
	const client = new S2({
		accessToken: "local-token",
		endpoints: {
			account: "http://localhost:8080",
			basin: "http://localhost:8080",
		},
	});
	// ANCHOR_END: custom-endpoints
	void client;
}

{
	const token = process.env.S2_ACCESS_TOKEN!;
	// ANCHOR: retry-config
	const client = new S2({
		accessToken: token,
		retry: {
			maxAttempts: 5,
			minBaseDelayMillis: 100,
			maxBaseDelayMillis: 2000,
		},
	});
	// ANCHOR_END: retry-config
	void client;
}

{
	const token = process.env.S2_ACCESS_TOKEN!;
	// ANCHOR: timeout-config
	const client = new S2({
		accessToken: token,
		connectionTimeoutMillis: 3000,
		requestTimeoutMillis: 5000,
	});
	// ANCHOR_END: timeout-config
	void client;
}

console.log("Configuration examples loaded");
