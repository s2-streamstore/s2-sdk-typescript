#!/usr/bin/env bun
/**
 * Simple dev server for the browser example.
 *
 * Usage:
 *   bun examples/browser/serve.ts
 *
 * Then open http://localhost:3000 in your browser.
 */

import { watch } from "fs";
import { dirname, join } from "path";

const BROWSER_DIR = dirname(import.meta.path);
const SRC_DIR = join(BROWSER_DIR, "../../src");
const PORT = parseInt(process.env.PORT || "3456", 10);

async function bundle() {
	const start = performance.now();
	const result = await Bun.build({
		entrypoints: [join(BROWSER_DIR, "app.ts")],
		outdir: BROWSER_DIR,
		target: "browser",
		format: "esm",
		sourcemap: "inline",
		// Don't minify for easier debugging
		minify: false,
	});

	if (!result.success) {
		console.error("Bundle failed:");
		for (const log of result.logs) {
			console.error(log);
		}
		return false;
	}

	const elapsed = (performance.now() - start).toFixed(0);
	console.log(
		`[${new Date().toISOString().slice(11, 19)}] Bundled in ${elapsed}ms`,
	);
	return true;
}

// Initial bundle
console.log("Building browser bundle...");
await bundle();

// Watch for changes
console.log(`Watching for changes in ${SRC_DIR}...`);
let debounceTimer: Timer | null = null;

watch(SRC_DIR, { recursive: true }, (_event, filename) => {
	if (!filename?.endsWith(".ts")) return;

	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = setTimeout(() => {
		console.log(`Changed: ${filename}`);
		bundle();
	}, 100);
});

// Also watch the app.ts file itself
watch(BROWSER_DIR, (_event, filename) => {
	if (filename !== "app.ts") return;

	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = setTimeout(() => {
		console.log(`Changed: ${filename}`);
		bundle();
	}, 100);
});

// Serve
const server = Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		let path = url.pathname;

		// Default to index.html
		if (path === "/") path = "/index.html";

		const filePath = join(BROWSER_DIR, path);
		const file = Bun.file(filePath);

		if (await file.exists()) {
			// Set correct content type
			const ext = path.split(".").pop();
			const contentType =
				{
					html: "text/html",
					js: "application/javascript",
					css: "text/css",
					map: "application/json",
				}[ext || ""] || "application/octet-stream";

			return new Response(file, {
				headers: {
					"Content-Type": contentType,
					// Allow CORS for API calls
					"Access-Control-Allow-Origin": "*",
				},
			});
		}

		return new Response("Not found", { status: 404 });
	},
});

console.log(`
=====================================
  S2 SDK Browser Test Server
=====================================

  Open: http://localhost:${PORT}

  - Watches for changes and rebuilds
  - Check DevTools Network tab to see
    if connections are being reused

Press Ctrl+C to stop
`);
