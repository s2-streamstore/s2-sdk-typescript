#!/usr/bin/env bun

/**
 * Generate src/version.ts from package.json.
 *
 * This keeps the version constant in TypeScript in sync with the
 * published package version without relying on placeholder strings
 * or post-build patching of compiled output.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pkgJsonPath = join(process.cwd(), "package.json");
const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as {
	version?: string;
};

const version = pkg.version ?? "0.0.0-development";
const outPath = join(process.cwd(), "src", "version.ts");

const contents = `/**
 * Library version.
 *
 * This file is auto-generated from package.json by scripts/generate-version.ts.
 * Do not edit manually.
 */
export const VERSION = ${JSON.stringify(version)};
`;

writeFileSync(outPath, contents, "utf-8");
console.log(`✓ Wrote src/version.ts with version ${version}`);
