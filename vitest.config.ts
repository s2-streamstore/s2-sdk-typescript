import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ mode }) => ({
  resolve: {
    alias: {
      '@s2-dev/streamstore': resolve(
        __dirname,
        'packages/streamstore/src/index.ts',
      ),
      '@s2-dev/resumable-stream': resolve(
        __dirname,
        'packages/resumable-stream/src/index.ts',
      ),
      '@s2-dev/resumable-stream/aisdk': resolve(
        __dirname,
        'packages/resumable-stream/src/aisdk.ts',
      ),
    },
  },
  test: {
    env: loadEnv(mode, process.cwd(), ''),
    // Deno tests use `deno test` directly — exclude from vitest
    exclude: ['**/deno.e2e.test.ts', '**/node_modules/**'],
    // Run e2e tests in a separate pool with limited concurrency
    poolMatchGlobs: [['**/*.e2e.test.ts', 'forks']],
    poolOptions: {
      forks: {
        maxForks: 1,
      },
    },
  },
}))
