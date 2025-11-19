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
    },
  },
  test: {
    env: loadEnv(mode, process.cwd(), ''),
  },
}))
