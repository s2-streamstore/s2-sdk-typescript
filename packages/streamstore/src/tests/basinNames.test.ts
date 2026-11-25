import { describe, expect, it } from "vitest";
import { S2Basin } from "../basin.js";
import { S2Error } from "../error.js";
import { S2 } from "../index.js";
import * as Redacted from "../lib/redacted.js";
import { cleanupAfterEach, serveHttp1 } from "./helpers.js";

const VALID_BASIN_NAMES = [
	"my-basin",
	"abcdefgh",
	"a".repeat(48),
	"1abcdefg",
	"0123456789",
	"a-b-c-d-e",
];

const INVALID_BASIN_NAMES = [
	"abcdefg",
	"a".repeat(49),
	"My-Basin",
	"-abcdefgh",
	"abcdefgh-",
	"my_basin1",
	"my.basin1",
	"evil.com#",
	"my basin",
	"",
	"ábcdefgh",
	"a/b",
];

describe("basin name validation (C9)", () => {
	const cleanup = cleanupAfterEach();

	it("accepts all valid BasinNameStr names and rejects invalid ones across every basin-accepting API without making HTTP requests", async () => {
		let requests = 0;
		const server = await serveHttp1((_req, res) => {
			requests++;
			res.writeHead(500);
			res.end();
		});
		cleanup(server.close);

		const client = new S2({
			accessToken: "token",
			endpoints: { account: server.origin, basin: server.origin },
			retry: { maxAttempts: 1 },
		});

		for (const valid of VALID_BASIN_NAMES) {
			expect(() => client.basin(valid), valid).not.toThrow();
		}

		for (const bad of INVALID_BASIN_NAMES) {
			expect(() => client.basin(bad), `S2.basin(${bad})`).toThrow(S2Error);
			expect(
				() =>
					new S2Basin(bad, {
						accessToken: Redacted.make("token"),
						baseUrl: server.origin,
						includeBasinHeader: false,
					}),
				`new S2Basin(${bad})`,
			).toThrow(S2Error);

			const ops: Array<[string, () => Promise<unknown>]> = [
				["basins.create", () => client.basins.create({ basin: bad })],
				["basins.getConfig", () => client.basins.getConfig({ basin: bad })],
				["basins.delete", () => client.basins.delete({ basin: bad })],
				["basins.ensure", () => client.basins.ensure({ basin: bad })],
				["basins.reconfigure", () => client.basins.reconfigure({ basin: bad })],
				[
					"metrics.basin",
					() => client.metrics.basin({ basin: bad, set: "storage" }),
				],
				[
					"metrics.stream",
					() =>
						client.metrics.stream({
							basin: bad,
							stream: "my-stream",
							set: "storage",
						}),
				],
			];

			for (const [label, op] of ops) {
				let error: unknown;
				try {
					await op();
				} catch (e) {
					error = e;
				}
				expect(error, `${label}(${JSON.stringify(bad)})`).toBeInstanceOf(
					S2Error,
				);
				expect(
					(error as S2Error).origin,
					`${label}(${JSON.stringify(bad)})`,
				).toBe("sdk");
			}
		}

		// Non-string JS inputs (including null-prototype objects) throw SDK S2Error, not TypeError.
		expect(() => client.basin(Object.create(null) as string)).toThrow(S2Error);

		expect(requests).toBe(0);
	});
});
