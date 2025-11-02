#!/usr/bin/env bun

/**
 * Post-proto generation script to add // @ts-nocheck to generated proto files
 * This prevents TypeScript from type-checking generated code that may have
 * strictness issues due to noUncheckedIndexedAccess being enabled.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function findProtoFiles(dir: string): string[] {
	const files: string[] = [];
	const entries = readdirSync(dir);
	
	for (const entry of entries) {
		const fullPath = join(dir, entry);
		const stat = statSync(fullPath);
		
		if (stat.isDirectory()) {
			files.push(...findProtoFiles(fullPath));
		} else if (entry.endsWith(".ts")) {
			files.push(fullPath);
		}
	}
	
	return files;
}

const protoDir = join(process.cwd(), "src", "generated", "proto");
const protoFiles = findProtoFiles(protoDir);

for (const file of protoFiles) {
	const content = readFileSync(file, "utf-8");
	
	// Only add @ts-nocheck if it's not already there
	if (!content.includes("// @ts-nocheck")) {
		const lines = content.split("\n");
		// Insert after the first line (which is usually the @generated comment)
		lines.splice(1, 0, "// @ts-nocheck");
		writeFileSync(file, lines.join("\n"), "utf-8");
		console.log(`✓ Added @ts-nocheck to ${file}`);
	}
}

