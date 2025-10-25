#!/usr/bin/env bun

/**
 * Fix imports in generated files by adding .js extensions
 * This script updates all relative imports in src/generated to include .js extensions
 * for proper ESM support with Node16+ module resolution.
 */

import { Glob } from "bun";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const generatedDir = join(process.cwd(), "src", "generated");

// Find all TypeScript files in the generated directory
const glob = new Glob("**/*.ts");
const files: string[] = [];

for await (const file of glob.scan({ cwd: generatedDir, absolute: true })) {
	files.push(file);
}

let totalFiles = 0;
let totalReplacements = 0;

for (const file of files) {
	const content = readFileSync(file, "utf-8");
	let modified = content;
	let fileReplacements = 0;

	// Pattern 1: import ... from './something' or '../something'
	// Matches: from './file' or from '../path/file' but not './file.js'
	modified = modified.replace(
		/from\s+['"](\..?\/[^'"]+?)(?<!\.js)['"]/g,
		(match, path) => {
			fileReplacements++;
			return `from '${path}.js'`;
		},
	);

	// Pattern 2: export ... from './something'
	// Matches: from './file' or from '../path/file' in export statements
	modified = modified.replace(
		/export\s+(?:type\s+)?\{[^}]+\}\s+from\s+['"](\..?\/[^'"]+?)(?<!\.js)['"]/g,
		(match, path) => {
			fileReplacements++;
			const beforeFrom = match.substring(0, match.lastIndexOf("from"));
			return `${beforeFrom}from '${path}.js'`;
		},
	);

	// Pattern 3: export * from './something'
	modified = modified.replace(
		/export\s+(?:type\s+)?\*\s+from\s+['"](\..?\/[^'"]+?)(?<!\.js)['"]/g,
		(match, path) => {
			fileReplacements++;
			return `export ${match.includes("type") ? "type " : ""}* from '${path}.js'`;
		},
	);

	if (fileReplacements > 0) {
		writeFileSync(file, modified, "utf-8");
		totalFiles++;
		totalReplacements += fileReplacements;
		console.log(`✓ Fixed ${fileReplacements} imports in ${file}`);
	}
}

console.log(
	`\n✨ Done! Fixed ${totalReplacements} imports across ${totalFiles} files.`,
);

