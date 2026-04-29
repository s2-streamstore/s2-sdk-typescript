import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const exampleRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(exampleRoot, "../..");
const port = Number.parseInt(process.env.PORT ?? "3458", 10);

function normalizeMode(value: string | undefined): string | null {
	if (value === "single-use" || value === "shared" || value === "session") {
		return value;
	}
	return null;
}

const streamMode =
	normalizeMode(process.env.VITE_S2_TANSTACK_MODE) ??
	normalizeMode(process.env.S2_TANSTACK_MODE) ??
	"session";

export default defineConfig({
	root: exampleRoot,
	define: {
		"import.meta.env.VITE_S2_TANSTACK_MODE": JSON.stringify(streamMode),
	},
	server: {
		host: process.env.HOSTNAME ?? "127.0.0.1",
		port,
	},
	resolve: {
		alias: {
			"@s2-dev/resumable-stream/tanstack-ai/client": resolve(
				repoRoot,
				"packages/resumable-stream/src/tanstack-ai-client.ts",
			),
			"@s2-dev/resumable-stream/tanstack-ai": resolve(
				repoRoot,
				"packages/resumable-stream/src/tanstack-ai.ts",
			),
			"@s2-dev/streamstore": resolve(
				repoRoot,
				"packages/streamstore/src/index.ts",
			),
		},
	},
	plugins: [tanstackStart(), react()],
});
