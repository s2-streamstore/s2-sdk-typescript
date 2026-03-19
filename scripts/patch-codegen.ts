#!/usr/bin/env bun

/**
 * Post-codegen patch script.
 *
 * Fixes generated @hey-api/openapi-ts output for Deno compatibility.
 *
 * Problem: The generated client spreads the entire `opts` object into
 * `new Request(url, requestInit)`. Node ignores unknown properties, but
 * Deno's Request constructor is strict and throws on non-standard fields
 * like `baseUrl`, `fetch`, `auth`, `parseAs`, etc.
 *
 * This script rewrites the requestInit construction to only pass valid
 * RequestInit properties.
 *
 * Run after `openapi-ts`:
 *   bun scripts/patch-codegen.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const GENERATED_DIR = join(
	import.meta.dir,
	"..",
	"packages",
	"streamstore",
	"src",
	"generated",
);

let patchCount = 0;

function patchFile(relPath: string, patches: Array<{ from: string; to: string }>) {
	const filePath = join(GENERATED_DIR, relPath);
	let content = readFileSync(filePath, "utf-8");

	for (const { from, to } of patches) {
		if (!content.includes(from)) {
			console.error(`✗ Could not find expected pattern in ${relPath}:`);
			console.error(`  Looking for: ${from.slice(0, 80)}...`);
			process.exit(1);
		}
		content = content.replace(from, to);
		patchCount++;
	}

	writeFileSync(filePath, content, "utf-8");
	console.log(`✓ Patched ${relPath}`);
}

// Patch 1: client.gen.ts — only pass valid RequestInit properties to new Request()
patchFile("client/client.gen.ts", [
	{
		from: [
			"    const requestInit: ReqInit = {",
			"      redirect: 'follow',",
			"      ...opts,",
			"      body: getValidRequestBody(opts),",
			"    };",
		].join("\n"),
		to: [
			"    const requestInit = {",
			"      redirect: opts.redirect ?? 'follow',",
			"      cache: opts.cache,",
			"      credentials: opts.credentials,",
			"      headers: opts.headers,",
			"      integrity: opts.integrity,",
			"      keepalive: opts.keepalive,",
			"      method: opts.method,",
			"      mode: opts.mode,",
			"      priority: opts.priority,",
			"      referrer: opts.referrer,",
			"      referrerPolicy: opts.referrerPolicy,",
			"      signal: opts.signal,",
			"      body: getValidRequestBody(opts),",
			"      ...('duplex' in opts ? { duplex: (opts as any).duplex } : undefined),",
			"    } as ReqInit;",
		].join("\n"),
	},
]);

// Patch 2: serverSentEvents.gen.ts — strip non-RequestInit properties before spreading
patchFile("core/serverSentEvents.gen.ts", [
	{
		from: [
			"        const requestInit: RequestInit = {",
			"          redirect: 'follow',",
			"          ...options,",
			"          body: options.serializedBody,",
			"          headers,",
			"          signal,",
			"        };",
		].join("\n"),
		to: [
			"        const { fetch: _fetchOpt, serializedBody: _sb, ...requestOptions } = options;",
			"        const requestInit: RequestInit = {",
			"          redirect: 'follow',",
			"          ...requestOptions,",
			"          body: options.serializedBody,",
			"          headers,",
			"          signal,",
			"        };",
		].join("\n"),
	},
]);

console.log(`\n✓ Applied ${patchCount} patches for Deno compatibility`);
