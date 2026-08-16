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
	it("bundles without pulling in Node-only compression modules", async () => {
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

			const imports = Object.values(result.metafile?.outputs ?? {}).flatMap(
				(output) => output.imports ?? [],
			);
			const http2Imports = imports.filter((i) => i.path === "node:http2");
			const zlibImports = imports.filter((i) => i.path === "node:zlib");

			expect(http2Imports.every((imp) => imp.external)).toBe(true);
			expect(zlibImports).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps protobuf out of the initial chunk", async () => {
		const dir = mkdtempSync(join(tmpdir(), "streamstore-bundle-"));
		try {
			const entry = join(dir, "entry.ts");
			writeFileSync(
				entry,
				[
					`import { S2 } from ${JSON.stringify(join(pkgRoot, "src/index.ts"))};`,
					`console.log(S2);`,
				].join("\n"),
			);

			const result = await build({
				entryPoints: [entry],
				bundle: true,
				platform: "browser",
				target: "es2020",
				external: ["node:http2"],
				format: "esm",
				splitting: true,
				outdir: join(dir, "dist"),
				metafile: true,
				logLevel: "silent",
				tsconfig: join(pkgRoot, "tsconfig.json"),
			});

			const outputs = result.metafile.outputs;
			const entryOutput = Object.keys(outputs).find((path) =>
				path.endsWith("/entry.js"),
			);
			expect(entryOutput).toBeDefined();

			const initialOutputs = new Set<string>();
			const visitInitialOutput = (path: string) => {
				if (initialOutputs.has(path)) return;
				initialOutputs.add(path);
				for (const imported of outputs[path]?.imports ?? []) {
					if (imported.kind === "import-statement" && outputs[imported.path]) {
						visitInitialOutput(imported.path);
					}
				}
			};
			visitInitialOutput(entryOutput!);

			const isProtoInput = (path: string) =>
				path.includes("@protobuf-ts/runtime") ||
				path.includes("generated/proto/s2.ts") ||
				path.includes("stream/transport/proto.ts");
			const initialProtoInputs = [...initialOutputs].flatMap((path) =>
				Object.keys(outputs[path]?.inputs ?? {}).filter(isProtoInput),
			);
			const lazyProtoInputs = Object.entries(outputs)
				.filter(([path]) => !initialOutputs.has(path))
				.flatMap(([, output]) =>
					Object.keys(output.inputs).filter(isProtoInput),
				);

			expect(initialProtoInputs).toEqual([]);
			expect(lazyProtoInputs.length).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
