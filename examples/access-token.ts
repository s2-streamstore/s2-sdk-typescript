import {
	AppendInput,
	AppendRecord,
	S2,
	S2Environment,
	S2Error,
} from "@s2-dev/streamstore";

const accessToken = process.env.S2_ACCESS_TOKEN;
if (!accessToken) {
	throw new Error("Set S2_ACCESS_TOKEN to a valid access token.");
}

const basinName = process.env.S2_BASIN;
if (!basinName) {
	throw new Error("Set S2_BASIN to point at your working basin.");
}

const adminClient = new S2({
	...S2Environment.parse(),
	accessToken,
});

// Issue a read-only token scoped to the entire account.
const readOnly = await adminClient.accessTokens.issue({
	id: `ts-example-read-only-${Date.now()}`,
	scope: {
		opGroups: {
			stream: { read: true },
		},
	},
	expiresAt: new Date(Date.UTC(2026, 5)),
});
console.log("Read-only token:", readOnly.accessToken);

// Next, issue a token confined to our basin and a stream prefix.
const granular = await adminClient.accessTokens.issue({
	id: `ts-example-granular-${Date.now()}`,
	scope: {
		basins: { exact: basinName },
		streams: { prefix: "tenant-a/" },
		ops: ["append", "create-stream", "list-streams"],
	},
	autoPrefixStreams: true,
});
console.log("Prefixed token:", granular.accessToken);

// Demonstrate how autoPrefixStreams rewrites names for the caller.
// We'll create a new S2 client using the token.
const tenantAClient = new S2({ accessToken: granular.accessToken });
const logicalStreamClient = tenantAClient.basin(basinName).stream("new-stream");

await logicalStreamClient.append(
	AppendInput.create([AppendRecord.string({ body: "scoped append" })]),
);

try {
	const batch = await logicalStreamClient.read({
		start: { from: { seqNum: 0 } },
	});
	console.dir(batch, { depth: null });
} catch (error: unknown) {
	if (error instanceof S2Error && error.status === 403) {
		console.log("Read failed because the token lacked read permission.");
	} else {
		throw error;
	}
}

const tenantAList = await tenantAClient.basin(basinName).streams.list();
console.log("List of streams viewed from tenant-a client:");
console.dir(tenantAList, { depth: null });

const adminList = await adminClient.basin(basinName).streams.list();
console.log("List of streams viewed from admin client:");
console.dir(adminList, { depth: null });

// Show all example tokens and clean them up to avoid clutter.
const tokensToRevoke = await adminClient.accessTokens.list({
	prefix: "ts-example-",
});
for (const token of tokensToRevoke.accessTokens) {
	console.log("Revoking token: %s", token.id);
	console.dir(token, { depth: null });
	await adminClient.accessTokens.revoke({ id: token.id });
}
