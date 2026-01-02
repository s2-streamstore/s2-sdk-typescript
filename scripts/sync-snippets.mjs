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
		name: "getting-started",
		file: "examples/getting-started.ts",
		lang: "ts",
	},
	{
		name: "retry-config",
		file: "examples/client-config.ts",
		lang: "ts",
	},
	{
		name: "append-session-create",
		file: "examples/append-session.ts",
		lang: "ts",
	},
	{
		name: "force-transport",
		file: "examples/force-transport.ts",
		lang: "ts",
	},
	{
		name: "access-token",
		file: "examples/access-token.ts",
		lang: "ts",
	},
	{
		name: "producer-basic",
		file: "examples/producer.ts",
		lang: "ts",
	},
	{
		name: "patterns-serialization",
		file: "examples/patterns-serialization.ts",
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
				extracted = contents.slice(afterStart + 1, endIdx);
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
