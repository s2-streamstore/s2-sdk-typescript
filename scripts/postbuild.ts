#!/usr/bin/env bun

/**
 * Post-build script:
 * - Add package.json files to dist directories so Node.js interprets module formats correctly
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
