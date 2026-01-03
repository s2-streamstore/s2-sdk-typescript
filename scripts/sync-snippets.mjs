#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const TARGETS = ["README.md", "packages/streamstore/README.md"];

const SNIPPETS = [
	{
		name: "quick-start",
		file: "examples/quick-start.ts",
		lang: "ts",
	},
	{
		name: "client-config",
		file: "examples/client-config.ts",
		lang: "ts",
	},
	{
		name: "data-plane-unary",
		file: "examples/data-plane-ops.ts",
		region: "data-plane-unary",
		lang: "ts",
	},
	{
		name: "data-plane-append-session",
		file: "examples/data-plane-ops.ts",
		region: "data-plane-append-session",
		lang: "ts",
	},
	{
		name: "producer-core",
		file: "examples/producer.ts",
		region: "producer-core",
		lang: "ts",
	},
	{
		name: "read-session-core",
		file: "examples/read-session.ts",
		region: "read-session-core",
		lang: "ts",
	},
	{
		name: "force-transport",
		file: "examples/force-transport.ts",
		region: "force-transport",
		lang: "ts",
	},
];

const loadedSnippets = new Map(
	await Promise.all(
		SNIPPETS.map(async (snippet) => {
			const abs = path.resolve(ROOT, snippet.file);
			const contents = await readFile(abs, "utf8");
			let extracted = contents;
			if (snippet.region) {
				const startToken = `snippet-region ${snippet.region} start`;
				const endToken = `snippet-region ${snippet.region} end`;
				const startIdx = contents.indexOf(startToken);
				if (startIdx === -1) {
					throw new Error(
						`Snippet region "${snippet.region}" not found in ${snippet.file}`,
					);
				}
				const afterStart = contents.indexOf("\n", startIdx);
				if (afterStart === -1) {
					throw new Error(
						`Snippet region "${snippet.region}" start marker must be followed by newline in ${snippet.file}`,
					);
				}
				const endIdx = contents.indexOf(endToken, afterStart);
				if (endIdx === -1) {
					throw new Error(
						`Snippet region "${snippet.region}" end marker not found in ${snippet.file}`,
					);
				}
				// Slice to the start of the end-marker line (not the token itself) so
				// comment prefixes like `// ` or `/* ` are not included in the snippet.
				const endLineStart = contents.lastIndexOf("\n", endIdx);
				extracted = contents.slice(
					afterStart + 1,
					endLineStart === -1 ? endIdx : endLineStart,
				);
			}
			return [
				snippet.name,
				{
					...snippet,
					content: extracted.trimEnd(),
				},
			];
		}),
	),
);

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let changedFiles = 0;

for (const relativeTarget of TARGETS) {
	const targetPath = path.resolve(ROOT, relativeTarget);
	let original = await readFile(targetPath, "utf8");
	let updated = original;

	for (const snippet of loadedSnippets.values()) {
		const start = `<!-- snippet:start ${snippet.name} -->`;
		const end = `<!-- snippet:end ${snippet.name} -->`;
		const pattern = new RegExp(
			`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`,
			"g",
		);

		let found = false;
		updated = updated.replace(pattern, () => {
			found = true;
			return `${start}
\`\`\`${snippet.lang}
${snippet.content}
\`\`\`
${end}`;
		});

		if (!found && relativeTarget === "README.md") {
			console.warn(
				`warning: snippet "${snippet.name}" not found in ${relativeTarget}`,
			);
		}
	}

	if (updated !== original) {
		await writeFile(targetPath, `${updated.trimEnd()}\n`, "utf8");
		changedFiles += 1;
	}
}

if (changedFiles > 0) {
	console.log(`Updated ${changedFiles} file(s) with synced snippets.`);
}
