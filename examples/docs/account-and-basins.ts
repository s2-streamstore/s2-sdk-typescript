/**
 * Documentation examples for Account and Basins page.
 * These snippets are extracted by the docs build script.
 *
 * Run with: npx tsx examples/docs/account-and-basins.ts
 * Requires: S2_ACCESS_TOKEN, S2_BASIN environment variables
 *
 * Note: These examples create resources with hardcoded names.
 * They may fail on repeated runs if resources already exist.
 */

import { S2, S2Environment } from "@s2-dev/streamstore";

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("S2_ACCESS_TOKEN is required");
}

const client = new S2({
	...S2Environment.parse(),
	accessToken,
});

const basinName = process.env.S2_BASIN;
if (!basinName) {
	throw new Error("S2_BASIN is required");
}

// ANCHOR: basin-operations
// List basins
const basins = await client.basins.list();

// Create a basin
await client.basins.create({ basin: "my-events" });

// Get configuration
const config = await client.basins.getConfig({ basin: "my-events" });

// Delete
await client.basins.delete({ basin: "my-events" });
// ANCHOR_END: basin-operations
console.log(`Basins: ${basins.basins.length} found, config:`, config);

const basin = client.basin(basinName);

// ANCHOR: stream-operations
// List streams
const streams = await basin.streams.list({ prefix: "user-" });

// Create a stream
await basin.streams.create({
	stream: "user-actions",
	config: {
		/* optional configuration */
	},
});

// Get configuration
const streamConfig = await basin.streams.getConfig({ stream: "user-actions" });

// Delete
await basin.streams.delete({ stream: "user-actions" });
// ANCHOR_END: stream-operations
console.log(`Streams: ${streams.streams.length} found, config:`, streamConfig);

// ANCHOR: access-token-basic
// List tokens (returns metadata, not the secret)
const tokens = await client.accessTokens.list();

// Issue a token scoped to streams under "users/1234/"
const { accessToken: issuedToken } = await client.accessTokens.issue({
	id: "user-1234-rw-token",
	scope: {
		basins: { prefix: "" }, // all basins
		streams: { prefix: "users/1234/" },
		opGroups: { stream: { read: true, write: true } },
	},
	expiresAt: new Date("2027-01-01"),
});

// Revoke a token
await client.accessTokens.revoke({ id: "user-1234-rw-token" });
// ANCHOR_END: access-token-basic
console.log(`Tokens: ${tokens.accessTokens.length} found, issued: ${issuedToken ? "yes" : "no"}`);

// ANCHOR: access-token-restricted
await client.accessTokens.issue({
	id: "restricted-token",
	scope: {
		basins: { exact: "production" }, // Only the "production" basin
		streams: { prefix: "logs/" }, // Only streams starting with "logs/"
		opGroups: { stream: { read: true } },
	},
});
// ANCHOR_END: access-token-restricted

console.log("Account and basins examples completed");

// The following are additional documentation snippets that are not executed.
// They would create tokens that aren't cleaned up.

function accessTokenReadOnly() {
	// ANCHOR: access-token-read-only
	client.accessTokens.issue({
		id: "consumer-token",
		scope: {
			opGroups: {
				stream: { read: true },
			},
		},
	});
	// ANCHOR_END: access-token-read-only
}

function accessTokenGranular() {
	// ANCHOR: access-token-granular
	client.accessTokens.issue({
		id: "append-only-token",
		scope: {
			ops: ["append", "check-tail"],
		},
	});
	// ANCHOR_END: access-token-granular
}

function accessTokenAutoPrefix() {
	// ANCHOR: access-token-auto-prefix
	// Issue a tenant-scoped token
	const tenantToken = client.accessTokens.issue({
		id: "tenant-a-token",
		scope: {
			basins: { exact: "shared-basin" },
			streams: { prefix: "tenant-a/" },
			ops: ["append", "read", "create-stream", "list-streams"],
		},
		autoPrefixStreams: true,
	});

	// Tenant's code sees a flat namespace
	// const tenantClient = new S2({ accessToken: tenantToken.accessToken });
	// const basin = tenantClient.basin("shared-basin");

	// Creates "tenant-a/orders" on the server
	// await basin.streams.create({ stream: "orders" });

	// Lists only streams in tenant-a/, but returns them without the prefix
	// const streams = await basin.streams.list(); // ["orders", "events", ...]

	// Appends to "tenant-a/orders" transparently
	// await basin
	// 	.stream("orders")
	// 	.append(AppendInput.create([AppendRecord.string({ body: "event" })]));
	// ANCHOR_END: access-token-auto-prefix
	void tenantToken;
}

void accessTokenReadOnly;
void accessTokenGranular;
void accessTokenAutoPrefix;

// Pagination example - not executed by default
async function paginationExample() {
	// ANCHOR: pagination
	// Iterate through all streams with automatic pagination
	for await (const stream of basin.streams.listAll()) {
		console.log(stream.name);
	}
	// ANCHOR_END: pagination
}
void paginationExample;
