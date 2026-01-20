/**
 * Documentation examples for SDK Overview page.
 * These snippets are extracted by the docs build script.
 *
 * Run with: npx tsx examples/docs/overview.ts
 * Requires: S2_ACCESS_TOKEN, S2_BASIN environment variables
 */

// ANCHOR: create-client
import { S2 } from "@s2-dev/streamstore";

const client = new S2({
	accessToken: process.env.S2_ACCESS_TOKEN!,
});

const basin = client.basin("my-basin");
const stream = basin.stream("my-stream");
// ANCHOR_END: create-client

void stream;

console.log("Client created successfully");
