import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { AppendInput, AppendRecord } from "../index.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const pkgRoot = join(__dirname, "..", "..");

describe("browser bundling", () => {
	it("bundles without pulling in node:http2", async () => {
		const dir = mkdtempSync(join(tmpdir(), "streamstore-bundle-"));
		try {
			const entry = join(dir, "entry.ts");
			// Target the source entry so we exercise tree-shaking and dynamic imports.
			writeFileSync(
				entry,
				[
					`import { S2 } from ${JSON.stringify(join(pkgRoot, "src/index.ts"))};`,
					`const client = new S2({ accessToken: "test-token", endpoints: { account: "https://example.com" } });`,
					`console.log(client ? "ok" : "fail");`,
				].join("\n"),
			);

			const result = await build({
				entryPoints: [entry],
				bundle: true,
				platform: "browser",
				target: "es2020",
				external: ["node:http2"],
				outfile: join(dir, "out.js"),
				metafile: true,
				logLevel: "silent",
				tsconfig: join(pkgRoot, "tsconfig.json"),
			});

			expect(result.errors).toHaveLength(0);
			expect(result.warnings).toHaveLength(0);

			const http2Imports = Object.values(
				result.metafile?.outputs ?? {},
			).flatMap(
				(output) =>
					output.imports?.filter((i) => i.path === "node:http2") ?? [],
			);

			expect(http2Imports.every((imp) => imp.external)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
