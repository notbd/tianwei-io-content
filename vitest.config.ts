import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // PGlite instances are cheap but not free; keep the default pool.
    testTimeout: 20_000,
  },
})
