#!/usr/bin/env bun

/**
 * Post-build script to add package.json files to dist directories
 * This ensures Node.js correctly interprets the module formats
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

// Add package.json to CJS dist to mark it as CommonJS
const cjsPackageJson = {
	type: "commonjs",
};

writeFileSync(
	join(process.cwd(), "dist", "cjs", "package.json"),
	JSON.stringify(cjsPackageJson, null, 2),
	"utf-8",
);

console.log("✓ Created dist/cjs/package.json");

